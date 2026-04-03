import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY env vars");
  process.exit(1);
}

export const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
  },
});

// --- Types ---

export interface User {
  id: string;
  api_key: string;
}

export interface ResearchEntry {
  user_id: string;
  content: string;
  sources: string[];
  gaps: string[];
  search_surface: string;
  tags: string[];
  raw_tokens: number;
  response_tokens: number;
  embedding: number[];
  replaces_id?: string;
  started_from_ids?: string[];
  volatility?: string;
}

export interface SearchResult {
  id: string;
  content: string;
  sources: string[];
  search_surface: string;
  tags: string[];
  raw_tokens: number;
  response_tokens: number;
  created_at: string;
  score: number;
  similarity: number;
  volatility: string;
  last_verified_at: string | null;
}

// --- Users ---

export async function registerUser(name?: string, clients?: string[]): Promise<User> {
  const { data, error } = await supabase
    .rpc("register_user", { user_name: name ?? null, user_clients: clients ?? [] });

  if (error) {
    throw new Error(`Registration failed: ${error.message}`);
  }

  return data[0];
}

export interface NetworkStats {
  total_users: number;
  total_contributions: number;
  total_tokens_saved: number;
}

export async function getNetworkStats(): Promise<NetworkStats & { days_active: number }> {
  const [users, contributions, savings, oldest] = await Promise.all([
    supabase.from("users").select("id", { count: "exact", head: true }),
    supabase.from("research").select("id", { count: "exact", head: true }).eq("is_current", true),
    supabase.from("searches").select("tokens_saved").gt("tokens_saved", 0),
    supabase.from("research").select("created_at").order("created_at", { ascending: true }).limit(1),
  ]);

  const totalTokensSaved = (savings.data ?? []).reduce((sum, r) => sum + r.tokens_saved, 0);
  const firstDate = oldest.data?.[0]?.created_at ? new Date(oldest.data[0].created_at) : new Date();
  const daysActive = Math.max(1, Math.ceil((Date.now() - firstDate.getTime()) / (1000 * 60 * 60 * 24)));

  return {
    total_users: users.count ?? 0,
    total_contributions: contributions.count ?? 0,
    total_tokens_saved: totalTokensSaved,
    days_active: daysActive,
  };
}

export async function getUserContributionCount(userId: string): Promise<number> {
  const { count } = await supabase
    .from("research")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .eq("is_current", true);

  return count ?? 0;
}

export async function incrementUserSearch(
  userId: string,
  matchType: "none" | "partial" | "full",
  tokensSaved: number = 0
): Promise<void> {
  const { error } = await supabase.rpc("increment_user_search", {
    p_user_id: userId,
    p_match_type: matchType,
    p_tokens_saved: tokensSaved,
  });
  if (error) console.error("User search increment error:", error);
}

export async function incrementUserContributions(
  userId: string,
  rawTokens: number = 0,
  responseTokens: number = 0
): Promise<void> {
  const { error } = await supabase.rpc("increment_user_contributions", {
    p_user_id: userId,
    p_raw_tokens: rawTokens,
    p_response_tokens: responseTokens,
  });
  if (error) console.error("User contribution increment error:", error);
}

export async function incrementCitations(researchIds: string[]): Promise<void> {
  const { error } = await supabase.rpc("increment_citations", {
    p_research_ids: researchIds,
  });
  if (error) console.error("Citations increment error:", error);
}

export async function getUserByApiKey(apiKey: string): Promise<User | null> {
  const { data, error } = await supabase
    .from("users")
    .select("id, api_key")
    .eq("api_key", apiKey)
    .single();

  if (error) return null;
  return data;
}

// --- Research ---

export async function hybridSearch(
  queryText: string,
  queryEmbedding: number[],
  matchCount: number = 5
): Promise<SearchResult[]> {
  const { data, error } = await supabase.rpc("hybrid_search", {
    query_text: queryText,
    query_embedding: JSON.stringify(queryEmbedding),
    result_limit: matchCount,
  });

  if (error) {
    console.error("Search error:", error);
    throw new Error(`Search failed: ${error.message}`);
  }

  const results: SearchResult[] = data ?? [];

  // Increment match_count on matched research entries + citations on owners (async, non-blocking)
  if (results.length > 0) {
    const ids = results.map((r) => r.id);
    supabase.rpc("increment_match_counts", { research_ids: ids }).then(({ error: incErr }) => {
      if (incErr) console.error("Match count increment error:", incErr);
    });
    incrementCitations(ids);
  }

  return results;
}

// --- Searches (event log) ---

export interface SearchLog {
  user_id: string;
  query_text: string;
  keywords: string;
  matched: boolean;
  match_count: number;
  results: { research_id: string; score: number; raw_tokens: number; response_tokens: number }[];
  tokens_saved: number;
  agent?: string;
  session_id?: string;
}

export async function logSearch(entry: SearchLog): Promise<void> {
  const { error } = await supabase.from("searches").insert({
    user_id: entry.user_id,
    query_text: entry.query_text,
    keywords: entry.keywords,
    matched: entry.matched,
    match_count: entry.match_count,
    results: entry.results,
    tokens_saved: entry.tokens_saved,
    agent: entry.agent ?? null,
    session_id: entry.session_id ?? null,
  });

  if (error) {
    // Log but don't fail the search — analytics should never block the user
    console.error("Search log error:", error);
  }
}

// --- Research ---

export interface InsertResult {
  id: string;
  version: number;
  previous_match_count?: number;
}

export async function insertResearch(entry: ResearchEntry): Promise<InsertResult> {
  let version = 1;
  let previous_match_count: number | undefined;
  let accumulatedSources = entry.sources;
  let accumulatedRawTokens = entry.raw_tokens;

  // If replacing an existing entry, accumulate sources and tokens from all prior versions
  if (entry.replaces_id) {
    const { data: old } = await supabase
      .from("research")
      .select("version, match_count, sources, raw_tokens")
      .eq("id", entry.replaces_id)
      .single();

    if (old) {
      version = old.version + 1;
      previous_match_count = old.match_count ?? 0;

      // Accumulate sources (union, no duplicates)
      const oldSources: string[] = old.sources ?? [];
      const merged = new Set([...oldSources, ...entry.sources]);
      accumulatedSources = [...merged];

      // Accumulate raw_tokens (total research effort across all versions)
      accumulatedRawTokens = (old.raw_tokens ?? 0) + entry.raw_tokens;

      await supabase
        .from("research")
        .update({ is_current: false })
        .eq("id", entry.replaces_id);
    }
  }

  const { data, error } = await supabase
    .from("research")
    .insert({
      user_id: entry.user_id,
      content: entry.content,
      sources: accumulatedSources,
      gaps: entry.gaps,
      search_surface: entry.search_surface,
      tags: entry.tags,
      raw_tokens: accumulatedRawTokens,
      response_tokens: entry.response_tokens,
      embedding: JSON.stringify(entry.embedding),
      replaces_id: entry.replaces_id ?? null,
      started_from_ids: entry.started_from_ids ?? [],
      volatility: entry.volatility ?? "stable",
      version,
      is_current: true,
    })
    .select("id")
    .single();

  if (error) {
    console.error("Insert error:", error);
    throw new Error(`Insert failed: ${error.message}`);
  }

  return { id: data.id, version, previous_match_count };
}

export async function verifyResearch(researchId: string): Promise<void> {
  const { error } = await supabase.rpc("verify_research", {
    p_research_id: researchId,
  });
  if (error) {
    throw new Error(`Verify failed: ${error.message}`);
  }
}
