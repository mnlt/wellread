-- Backfill raw_tokens and research_turns for entries without real measurement.
-- Uses median per-tool-call estimates from empirical JSONL analysis:
--   raw_tokens: ~8,400 per source (median incremental cost per tool call)
--   research_turns: ~3 per source (median turns per tool call)
-- Only updates entries where total_context = 0 (not yet measured by PostToolUse hook).
UPDATE research
SET
  raw_tokens = GREATEST(array_length(sources, 1), 1) * 8400,
  research_turns = GREATEST(array_length(sources, 1), 1) * 3
WHERE total_context = 0 OR total_context IS NULL;
