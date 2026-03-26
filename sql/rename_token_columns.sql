-- Rename token columns in users table
ALTER TABLE users RENAME COLUMN tokens_searched TO tokens_kept;
ALTER TABLE users RENAME COLUMN tokens_contributed TO tokens_donated;
ALTER TABLE users RENAME COLUMN tokens_synthesized TO tokens_distilled;

-- Update increment_user_search function
CREATE OR REPLACE FUNCTION increment_user_search(
  p_user_id uuid,
  p_match_type text,
  p_tokens_saved int default 0
)
RETURNS void
LANGUAGE sql
AS $$
  UPDATE users
  SET
    search_count = search_count + 1,
    no_match_count = no_match_count + CASE WHEN p_match_type = 'none' THEN 1 ELSE 0 END,
    partial_match_count = partial_match_count + CASE WHEN p_match_type = 'partial' THEN 1 ELSE 0 END,
    full_match_count = full_match_count + CASE WHEN p_match_type = 'full' THEN 1 ELSE 0 END,
    tokens_kept = tokens_kept + p_tokens_saved
  WHERE id = p_user_id;
$$;

-- Update increment_user_contributions function
CREATE OR REPLACE FUNCTION increment_user_contributions(
  p_user_id uuid,
  p_raw_tokens int default 0,
  p_response_tokens int default 0
)
RETURNS void
LANGUAGE sql
AS $$
  UPDATE users
  SET
    contribution_count = contribution_count + 1,
    tokens_donated = tokens_donated + p_raw_tokens,
    tokens_distilled = tokens_distilled + p_response_tokens
  WHERE id = p_user_id;
$$;
