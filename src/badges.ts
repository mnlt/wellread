import { formatTokens } from "./utils.js";

// ─────────────────────────────────────────────────────────────────
// Client stats — what the local helper script (~/.wellread/usage-stats.mjs)
// reads from Claude Code's JSONL files. The hook injects this into the prompt
// and the agent passes it as a tool param. Everything optional — degrades silently.
// ─────────────────────────────────────────────────────────────────

export interface ClientStats {
  windowStart?: string;   // "09:00" — local time when the current 5h window started
  windowEnd?: string;     // "14:00"
  turns?: number;         // assistant messages in current window (account-wide)
  billable?: number;      // input + cache_creation + output in current window
  cacheRead?: number;     // cache_read tokens in current window
  minutesLeft?: number;   // minutes until window resets
  contextSize?: number;   // current conversation's input tokens (this workspace)
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
  if (typeof obj.turns === "number") out.turns = obj.turns;
  if (typeof obj.billable === "number") out.billable = obj.billable;
  if (typeof obj.cacheRead === "number") out.cacheRead = obj.cacheRead;
  if (typeof obj.minutesLeft === "number") out.minutesLeft = obj.minutesLeft;
  if (typeof obj.contextSize === "number") out.contextSize = obj.contextSize;
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

function buildWindowBlock(stats?: ClientStats): string {
  if (!stats || !stats.windowStart || !stats.windowEnd) return "";
  const turns = safeInt(stats.turns ?? 0);
  const billable = safeInt(stats.billable ?? 0);
  const minutesLeft = safeInt(stats.minutesLeft ?? 0);
  return `\n\n   Your 5h window: ${stats.windowStart}–${stats.windowEnd}\n   ${turns} turns · ${formatTokens(billable)} billable · ${formatTimeLeft(minutesLeft)} until reset`;
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

  return `${buildHeader()}\n\n💧 Read ${rawStr} from ${data.resultsCount} ${sourceWord} for you. Left ${respStr} in your context.\n   ${arrowLine}${buildWindowBlock(stats)}`;
}

// ─────────────────────────────────────────────────────────────────
// Badge: Built on prior research (save with started_from_ids)
// ─────────────────────────────────────────────────────────────────

export function buildBuiltOnBadge(stats?: ClientStats): string {
  return `${buildHeader()}\n\n🧩 Half the answer was already cached. Your agent only researched the gaps.\n   ↳ The hard part was already done. The next person gets the complete version.${buildWindowBlock(stats)}`;
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

export function buildSaveBadge(data: SaveBadgeData, stats?: ClientStats): string {
  const sourcesCount = safeInt(data.sourcesCount);
  const respTokens = safeInt(data.responseTokens);
  const contribNumber = safeInt(data.contributionNumber) || 1;
  const sourceWord = sourcesCount === 1 ? "source" : "sources";
  const contribMsg = getContributionMessage(contribNumber);
  return `${buildHeader()}\n\n🌱 Added to the network. ${sourcesCount} ${sourceWord} distilled into ${formatTokens(respTokens)} tokens.\n   ↳ Contribution #${contribNumber}. ${contribMsg}${buildWindowBlock(stats)}`;
}
