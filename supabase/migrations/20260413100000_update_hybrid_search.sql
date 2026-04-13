-- Add total_context and research_turns to hybrid_search return type.
-- Must DROP first because Postgres doesn't allow changing return type with CREATE OR REPLACE.
drop function if exists hybrid_search(text, extensions.vector, int, float, float, int);

create function hybrid_search(
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
  total_context int,
  research_turns int,
  created_at timestamptz,
  score float,
  similarity float,
  volatility text,
  last_verified_at timestamptz
)
language sql stable
set search_path = public, extensions
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
      and -(r.embedding <#> query_embedding) > 0.5
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
    r.total_context,
    r.research_turns,
    r.created_at,
    (
      coalesce(1.0 / (rrf_k + ft.rank_ix), 0.0) * full_text_weight +
      coalesce(1.0 / (rrf_k + s.rank_ix), 0.0) * semantic_weight
    ) as score,
    coalesce(s.cosine_sim, 0.0) as similarity,
    r.volatility,
    r.last_verified_at
  from
    full_text ft
    full outer join semantic s on ft.id = s.id
    join research r on coalesce(ft.id, s.id) = r.id
  order by score desc
  limit least(result_limit, 30);
$$;
