-- Follow-up searches: given research IDs that matched a search,
-- find what users searched for NEXT in the same session.
-- This powers "others then researched:" suggestions.

CREATE OR REPLACE FUNCTION get_follow_up_searches(
  p_research_ids TEXT[],
  p_exclude_query TEXT DEFAULT NULL,
  p_limit INT DEFAULT 5
)
RETURNS TABLE(query_text TEXT, search_count BIGINT)
LANGUAGE sql STABLE
AS $$
  WITH matching_searches AS (
    SELECT DISTINCT s.session_id, s.created_at
    FROM searches s,
         jsonb_array_elements(s.results) AS elem
    WHERE elem->>'research_id' = ANY(p_research_ids)
      AND s.session_id IS NOT NULL
  ),
  follow_ups AS (
    SELECT s2.query_text
    FROM matching_searches ms
    JOIN searches s2
      ON s2.session_id = ms.session_id
     AND s2.created_at > ms.created_at
    WHERE s2.matched = true
  )
  SELECT f.query_text, COUNT(*) AS search_count
  FROM follow_ups f
  WHERE (p_exclude_query IS NULL OR f.query_text != p_exclude_query)
  GROUP BY f.query_text
  ORDER BY search_count DESC
  LIMIT p_limit;
$$;

-- Index for efficient JSONB lookup on results array
CREATE INDEX IF NOT EXISTS idx_searches_results_gin
  ON searches USING GIN (results);

-- Index for session-based temporal lookups
CREATE INDEX IF NOT EXISTS idx_searches_session_created
  ON searches (session_id, created_at)
  WHERE session_id IS NOT NULL;
