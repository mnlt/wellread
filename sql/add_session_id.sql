-- Add session_id to searches table
ALTER TABLE searches ADD COLUMN session_id text;
CREATE INDEX searches_session_id_idx ON searches (session_id);
