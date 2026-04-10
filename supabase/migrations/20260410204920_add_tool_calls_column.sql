-- Store the ordered list of tool calls the agent made during research.
-- Used to compute compound token cost (each turn re-sends prior context).
ALTER TABLE public.research ADD COLUMN IF NOT EXISTS tool_calls TEXT[] DEFAULT '{}';
