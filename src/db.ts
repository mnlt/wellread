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
  search_surface: string;
  tags: string[];
  raw_tokens: number;
  response_tokens: number;
  embedding: number[];
  replaces_id?: string;
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

  // Increment match_count on matched research entries (async, non-blocking)
  if (results.length > 0) {
    const ids = results.map((r) => r.id);
    supabase.rpc("increment_match_counts", { research_ids: ids }).then(({ error: incErr }) => {
      if (incErr) console.error("Match count increment error:", incErr);
    });
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
  });

  if (error) {
    // Log but don't fail the search — analytics should never block the user
    console.error("Search log error:", error);
  }
}

// --- Research ---

export async function insertResearch(entry: ResearchEntry): Promise<string> {
  let version = 1;

  // If replacing an existing entry, mark it as not current and get its version
  if (entry.replaces_id) {
    const { data: old } = await supabase
      .from("research")
      .select("version, match_count")
      .eq("id", entry.replaces_id)
      .single();

    if (old) {
      version = old.version + 1;

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
      sources: entry.sources,
      search_surface: entry.search_surface,
      tags: entry.tags,
      raw_tokens: entry.raw_tokens,
      response_tokens: entry.response_tokens,
      embedding: JSON.stringify(entry.embedding),
      replaces_id: entry.replaces_id ?? null,
      version,
      is_current: true,
    })
    .select("id")
    .single();

  if (error) {
    console.error("Insert error:", error);
    throw new Error(`Insert failed: ${error.message}`);
  }

  return data.id;
}
