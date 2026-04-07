import { formatTokens } from "./utils.js";

// ─────────────────────────────────────────────────────────────────
// Client stats — what the local helper script (~/.wellread/usage-stats.mjs)
// reads from Claude Code's JSONL files. The hook injects this into the prompt
// and the agent passes it as a tool param. Everything optional — degrades silently.
// ─────────────────────────────────────────────────────────────────

export interface ClientStats {
  windowStart?: string;     // "09:00" — local time when the current 5h window started
  windowEnd?: string;       // "14:00"
  windowStartMs?: number;   // epoch ms — exact window start, used by db queries
  turns?: number;           // assistant messages in current window (account-wide)
  billable?: number;        // input + cache_creation + output in current window
  minutesLeft?: number;     // minutes until window resets
  contextSize?: number;     // current conversation's input tokens (this workspace)
  // Optional: Anthropic's authoritative rate-limit percentages, captured by
  // the statusLine helper from API response headers. Only present when the
  // user has configured the wellread statusLine command and the helper has
  // had a chance to fire (it runs every TUI redraw). If absent, the badge
  // falls back to its existing display without the counterfactual line.
  fiveHourPct?: number;     // 0-100, "Current session" as shown in /usage
  sevenDayPct?: number;     // 0-100, "Current week (all models)" as shown in /usage
}

// Accepts the param as either string (JSON) or object, returns clean ClientStats or undefined
export function parseClientStats(raw: unknown): ClientStats | undefined {
  if (raw == null) return undefined;
  let obj: any = raw;
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed || trimmed === "{}") return undefined;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      return undefined;
    }
  }
  if (typeof obj !== "object") return undefined;
  const out: ClientStats = {};
  if (typeof obj.windowStart === "string") out.windowStart = obj.windowStart;
  if (typeof obj.windowEnd === "string") out.windowEnd = obj.windowEnd;
  if (typeof obj.windowStartMs === "number" && Number.isFinite(obj.windowStartMs)) out.windowStartMs = obj.windowStartMs;
  if (typeof obj.turns === "number") out.turns = obj.turns;
  if (typeof obj.billable === "number") out.billable = obj.billable;
  if (typeof obj.minutesLeft === "number") out.minutesLeft = obj.minutesLeft;
  if (typeof obj.contextSize === "number") out.contextSize = obj.contextSize;
  if (typeof obj.fiveHourPct === "number") out.fiveHourPct = obj.fiveHourPct;
  if (typeof obj.sevenDayPct === "number") out.sevenDayPct = obj.sevenDayPct;
  return out;
}

// ─────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────

// Sanitize a number coming from outside — guards against NaN/Infinity/negatives.
function safeInt(n: number): number {
  if (typeof n !== "number" || !Number.isFinite(n) || n < 0) return 0;
  return Math.floor(n);
}

function formatTimeLeft(minutes: number): string {
  if (minutes <= 0) return "<1min";
  if (minutes < 60) return `${minutes}min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}min`;
}

function buildWindowBlock(stats?: ClientStats, savedInWindow?: number): string {
  if (!stats || !stats.windowStart || !stats.windowEnd) return "";
  const turns = safeInt(stats.turns ?? 0);
  const billable = safeInt(stats.billable ?? 0);
  const minutesLeft = safeInt(stats.minutesLeft ?? 0);
  const base = `\n\n   Your 5h window: ${stats.windowStart}–${stats.windowEnd}\n   ${turns} turns · ${formatTokens(billable)} billable · ${formatTimeLeft(minutesLeft)} until reset`;
  return base + buildCounterfactualLine(stats, savedInWindow);
}

function buildHeader(): string {
  return "── **wellread.md** ──";
}

// ─────────────────────────────────────────────────────────────────
// Badge: Hit (full match from search)
// ─────────────────────────────────────────────────────────────────

export interface HitBadgeData {
  totalRawTokens: number;
  totalResponseTokens: number;
  resultsCount: number;
  // Optional: total tokens wellread has saved for this user in the current 5h
  // window (sum of `tokens_saved` over all matched searches in the last 5h).
  // Combined with stats.fiveHourPct and stats.billable, this lets us compute
  // and display the counterfactual: "you'd be at X% instead of Y% without us".
  // Only available when the caller (search.ts) queried it before building.
  savedInWindow?: number;
}

// Compute the counterfactual delta line if and only if we have all four pieces:
//   - the user's current 5h utilization % (from Anthropic via statusLine)
//   - the user's actual billable in the window (from the local helper)
//   - tokens saved by wellread in this same window (from db query)
//   - the saved amount is meaningful (≥5% of effort AND ≥50K absolute)
//
// The math:
//   counterfactualPct = currentPct × (billable + saved) / billable
//
// This is the ONE thing wellread can show that nobody else can: by how much
// has the cache pushed back the user's wall in this exact window. /usage
// shows where you ARE; this shows what wellread BOUGHT YOU.
function buildCounterfactualLine(stats: ClientStats | undefined, savedInWindow: number | undefined): string {
  if (!stats || typeof stats.fiveHourPct !== "number" || typeof stats.billable !== "number") return "";
  if (typeof savedInWindow !== "number" || savedInWindow <= 0) return "";
  if (stats.billable <= 0) return "";

  // Threshold: don't render noise. Need both meaningful absolute (≥50K saved)
  // and meaningful relative (≥5% of total effort) for the line to be honest.
  const effortRatio = savedInWindow / (stats.billable + savedInWindow);
  if (savedInWindow < 50_000 || effortRatio < 0.05) return "";

  const currentPct = stats.fiveHourPct;
  const counterfactualPct = currentPct * (stats.billable + savedInWindow) / stats.billable;

  // Format: integer % when both are ≥10, one decimal otherwise.
  const fmt = (n: number) => (n >= 10 ? Math.round(n).toString() : n.toFixed(1));

  // If the counterfactual exceeds 100%, the user would have ALREADY hit the
  // wall without wellread. Render that explicitly instead of clamping to 100
  // (which would be a quiet lie).
  if (counterfactualPct >= 100) {
    return `\n   ↳ Your 5h is at ${fmt(currentPct)}%. Without wellread you'd already have hit the wall.`;
  }

  // Don't render if the delta rounds to <1% — too small to feel meaningful.
  const delta = counterfactualPct - currentPct;
  if (delta < 1) return "";

  return `\n   ↳ Your 5h is at ${fmt(currentPct)}%. Without wellread you'd be at ${fmt(counterfactualPct)}%.`;
}

export function buildHitBadge(data: HitBadgeData, stats?: ClientStats): string {
  const rawTokens = safeInt(data.totalRawTokens);
  const respTokens = safeInt(data.totalResponseTokens);
  const saved = Math.max(0, rawTokens - respTokens);
  const ctxSize = safeInt(stats?.contextSize ?? 0);
  const sourceWord = data.resultsCount === 1 ? "source" : "sources";

  const rawStr = formatTokens(rawTokens);
  const respStr = formatTokens(respTokens);

  // Build the arrow line. Priority order:
  // 1. If we have a meaningful context size and saved>0, show "% lighter".
  //    Clamp to 99% so we never print absurd numbers (>100%) when saved
  //    happens to exceed the current conversation's context size.
  //    Skip the % path if it would round to <0.1% — that's worse than no number.
  // 2. If saved>0 but no context size, show absolute saved tokens.
  // 3. If saved<=0 (uncompressed entries), say something honest about reuse.
  let arrowLine: string;
  if (ctxSize > 0 && saved > 0) {
    const rawPct = (saved / ctxSize) * 100;
    const pct = Math.min(rawPct, 99);
    if (pct >= 0.1) {
      const pctStr = pct >= 10 ? pct.toFixed(0) : pct.toFixed(1);
      arrowLine = `↳ Your context is now ~${pctStr}% lighter than it would have been.`;
    } else {
      // Tiny percentage — fall back to absolute tokens
      arrowLine = `↳ ${formatTokens(saved)} of source material never entered your conversation.`;
    }
  } else if (saved > 0) {
    arrowLine = `↳ ${formatTokens(saved)} of source material never entered your conversation.`;
  } else {
    arrowLine = `↳ The cached entry is what your agent would have produced anyway. You skipped the research.`;
  }

  return `${buildHeader()}\n\n💧 Read ${rawStr} from ${data.resultsCount} ${sourceWord} for you. Left ${respStr} in your context.\n   ${arrowLine}${buildWindowBlock(stats, data.savedInWindow)}`;
}

// ─────────────────────────────────────────────────────────────────
// Badge: Built on prior research (save with started_from_ids)
// ─────────────────────────────────────────────────────────────────

export function buildBuiltOnBadge(stats?: ClientStats, savedInWindow?: number): string {
  return `${buildHeader()}\n\n🧩 Half the answer was already cached. Your agent only researched the gaps.\n   ↳ The hard part was already done. The next person gets the complete version.${buildWindowBlock(stats, savedInWindow)}`;
}

// ─────────────────────────────────────────────────────────────────
// Badge: Save (new contribution after miss)
// ─────────────────────────────────────────────────────────────────

const CONTRIBUTION_MILESTONES: Record<number, string> = {
  1: "You just planted the first seed. Every dev who asks this from now on gets your work.",
  2: "Two and counting. The network is starting to remember you.",
  3: "Three contributions. You're already past 80% of users.",
  5: "Five seeds in the ground. This is what compounding looks like.",
  10: "Ten contributions. Other agents are quietly relying on your research.",
  25: "Twenty-five entries. You're a pillar of this network now.",
  50: "Fifty. You're shaping how the next generation of devs learns.",
  100: "One hundred. Anthropic should be paying you. (They're not.)",
  250: "Two hundred fifty. The network has a Manuel-shaped corner now.",
  500: "Five hundred. You're not a contributor, you're infrastructure.",
};

function getContributionMessage(n: number): string {
  if (CONTRIBUTION_MILESTONES[n]) return CONTRIBUTION_MILESTONES[n];
  return "Each one makes the next dev's work a little easier.";
}

export interface SaveBadgeData {
  sourcesCount: number;
  responseTokens: number;
  contributionNumber: number;
}

export function buildSaveBadge(data: SaveBadgeData, stats?: ClientStats, savedInWindow?: number): string {
  const sourcesCount = safeInt(data.sourcesCount);
  const respTokens = safeInt(data.responseTokens);
  const contribNumber = safeInt(data.contributionNumber) || 1;
  const sourceWord = sourcesCount === 1 ? "source" : "sources";
  const contribMsg = getContributionMessage(contribNumber);
  return `${buildHeader()}\n\n🌱 Added to the network. ${sourcesCount} ${sourceWord} distilled into ${formatTokens(respTokens)} tokens.\n   ↳ Contribution #${contribNumber}. ${contribMsg}${buildWindowBlock(stats, savedInWindow)}`;
}
