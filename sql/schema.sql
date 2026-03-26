-- WellRead MCP — Supabase Schema
-- Run this in the Supabase SQL Editor

-- 1. Enable pgvector
create extension if not exists vector
with schema extensions;

-- 2. Users table
create table users (
  id uuid primary key default gen_random_uuid(),
  api_key text unique not null default ('wr_' || replace(gen_random_uuid()::text, '-', '')),
  name text,
  clients text[] default '{}',  -- tools detected at install: claude-code, cursor, windsurf, etc.

  -- Usage counters (incremented atomically on each search/contribute)
  search_count int not null default 0,
  no_match_count int not null default 0,
  partial_match_count int not null default 0,
  full_match_count int not null default 0,
  contribution_count int not null default 0,

  -- Token economics
  tokens_kept bigint not null default 0,        -- tokens you conserved by hitting cache (accumulated)
  tokens_donated bigint not null default 0,     -- tokens you processed from external sources for the community (accumulated)
  tokens_distilled bigint not null default 0,   -- tokens in your saved research entries (accumulated)
  citations_count int not null default 0,         -- times your research appeared in others' searches

  created_at timestamptz default now()
);

create index users_api_key_idx on users (api_key);

-- 3. Research table
create table research (
  id uuid primary key default gen_random_uuid(),

  -- Who contributed this
  user_id uuid not null references users(id),

  -- Versioning: if this entry replaces an older one
  replaces_id uuid references research(id),
  version int not null default 1,
  is_current boolean not null default true,

  -- What gets returned to the searching agent
  content text not null,
  sources text[] not null default '{}',

  -- Rabbit holes: gaps and unexplored angles for future investigators
  gaps text[] default '{}',

  -- What gets searched (optimized for retrieval)
  search_surface text not null,
  tags text[] default '{}',

  -- Token economics
  raw_tokens int not null default 0,       -- tokens the LLM processed during research
  response_tokens int not null default 0,  -- tokens in the saved synthesis

  -- Usage stats
  match_count int not null default 0,      -- how many searches matched this entry

  -- Vector embedding of search_surface (512 dims, text-embedding-3-small)
  embedding extensions.vector(512),

  -- Auto-generated tsvector for full-text search
  fts tsvector generated always as (
    to_tsvector('english', search_surface)
  ) stored,

  created_at timestamptz default now()
);

-- 4. Indexes
create index research_embedding_idx on research
  using hnsw (embedding extensions.vector_ip_ops);

create index research_fts_idx on research
  using gin (fts);

create index research_tags_idx on research
  using gin (tags);

create index research_user_id_idx on research (user_id);
create index research_is_current_idx on research (is_current) where is_current = true;
create index research_replaces_id_idx on research (replaces_id);

-- 5. Hybrid search function (vector + full-text, fused with RRF)
create or replace function hybrid_search(
  query_text text,
  query_embedding extensions.vector(512),
  result_limit int default 10,
  full_text_weight float default 0.3,
  semantic_weight float default 0.7,
  rrf_k int default 50
)
returns table (
  id uuid,
  content text,
  sources text[],
  search_surface text,
  tags text[],
  raw_tokens int,
  response_tokens int,
  created_at timestamptz,
  score float,
  similarity float
)
language sql stable
as $$
  with full_text as (
    select
      r.id,
      row_number() over (
        order by ts_rank_cd(r.fts, websearch_to_tsquery(query_text)) desc
      ) as rank_ix
    from research r
    where r.is_current = true
      and r.fts @@ websearch_to_tsquery(query_text)
    order by rank_ix
    limit least(result_limit, 30) * 2
  ),
  semantic as (
    select
      r.id,
      -(r.embedding <#> query_embedding) as cosine_sim,
      row_number() over (
        order by r.embedding <#> query_embedding
      ) as rank_ix
    from research r
    where r.is_current = true
      and -(r.embedding <#> query_embedding) > 0.5  -- minimum cosine similarity
    order by rank_ix
    limit least(result_limit, 30) * 2
  )
  select
    r.id,
    r.content,
    r.sources,
    r.search_surface,
    r.tags,
    r.raw_tokens,
    r.response_tokens,
    r.created_at,
    (
      coalesce(1.0 / (rrf_k + ft.rank_ix), 0.0) * full_text_weight +
      coalesce(1.0 / (rrf_k + s.rank_ix), 0.0) * semantic_weight
    ) as score,
    coalesce(s.cosine_sim, 0.0) as similarity
  from
    full_text ft
    full outer join semantic s on ft.id = s.id
    join research r on coalesce(ft.id, s.id) = r.id
  order by score desc
  limit least(result_limit, 30);
$$;

-- 6. Searches table (event log for analytics)
create table searches (
  id uuid primary key default gen_random_uuid(),

  -- Who searched
  user_id uuid not null references users(id),

  -- What was searched (abstracted, no user-specific data)
  query_text text not null,        -- the abstracted query sent to search
  keywords text not null,          -- keywords used for BM25

  -- Results
  matched boolean not null default false,
  match_count int not null default 0,
  results jsonb default '[]',      -- [{research_id, score, raw_tokens, response_tokens}]
  tokens_saved int not null default 0,  -- sum of (raw_tokens - response_tokens) for matches

  -- Context
  agent text,                      -- "claude-code", "cursor", "gemini-cli", "windsurf", etc.

  created_at timestamptz default now()
);

-- Indexes for analytics queries
create index searches_user_id_idx on searches (user_id);
create index searches_created_at_idx on searches (created_at);
create index searches_matched_idx on searches (matched);
create index searches_agent_idx on searches (agent);
-- Composite for cohort/retention queries (user + time)
create index searches_user_time_idx on searches (user_id, created_at);

-- 7. Increment match counts atomically
create or replace function increment_match_counts(research_ids uuid[])
returns void
language sql
as $$
  update research
  set match_count = match_count + 1
  where id = any(research_ids);
$$;

-- 8. Increment user stats atomically
create or replace function increment_user_search(
  p_user_id uuid,
  p_match_type text,  -- 'none', 'partial', 'full'
  p_tokens_saved int default 0
)
returns void
language sql
as $$
  update users
  set
    search_count = search_count + 1,
    no_match_count = no_match_count + case when p_match_type = 'none' then 1 else 0 end,
    partial_match_count = partial_match_count + case when p_match_type = 'partial' then 1 else 0 end,
    full_match_count = full_match_count + case when p_match_type = 'full' then 1 else 0 end,
    tokens_kept = tokens_kept + p_tokens_saved
  where id = p_user_id;
$$;

create or replace function increment_user_contributions(
  p_user_id uuid,
  p_raw_tokens int default 0,
  p_response_tokens int default 0
)
returns void
language sql
as $$
  update users
  set
    contribution_count = contribution_count + 1,
    tokens_donated = tokens_donated + p_raw_tokens,
    tokens_distilled = tokens_distilled + p_response_tokens
  where id = p_user_id;
$$;

create or replace function increment_citations(p_research_ids uuid[])
returns void
language sql
as $$
  update users
  set citations_count = citations_count + sub.cnt
  from (
    select user_id, count(*)::int as cnt
    from research
    where id = any(p_research_ids)
    group by user_id
  ) sub
  where users.id = sub.user_id;
$$;

-- 9. Register user function (called during install)
create or replace function register_user(user_name text default null, user_clients text[] default '{}')
returns table (id uuid, api_key text)
language sql
as $$
  insert into users (name, clients)
  values (user_name, user_clients)
  returning id, api_key;
$$;
