import { formatTokens } from "./utils.js";

// ─────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────

function safeInt(n: number): number {
  if (typeof n !== "number" || !Number.isFinite(n) || n < 0) return 0;
  return Math.floor(n);
}

// Format tokens with 1 decimal for K (e.g. "5.4K"), no ~ prefix.
// 0-999 → "800", 1K-9.9K → "5.4K", 10K+ → "12K", 1M+ → "1.2M"
function formatTokensDecimal(tokens: number): string {
  const t = safeInt(tokens);
  if (t >= 950_000) {
    const m = t / 1_000_000;
    return m >= 10 ? `${m.toFixed(0)}M` : `${m.toFixed(1)}M`;
  }
  if (t >= 10_000) return `${Math.round(t / 1000)}K`;
  if (t >= 1000) {
    const k = t / 1000;
    const formatted = k % 1 === 0 ? `${k.toFixed(0)}K` : `${k.toFixed(1)}K`;
    return formatted;
  }
  return String(t);
}

function volatilityLabel(volatility: string | undefined): string {
  if (!volatility) return "stable content";
  const v = volatility.toLowerCase();
  if (v === "evolving" || v === "volatile") return "volatile content";
  return "stable content";
}

// Age formatting: 0 → "today", 1 → "1d ago", etc.
function formatAge(days: number): string {
  const d = safeInt(days);
  if (d === 0) return "today";
  if (d === 1) return "1d ago";
  if (d < 30) return `${d}d ago`;
  if (d < 60) return "1mo ago";
  if (d < 365) return `${Math.floor(d / 30)}mo ago`;
  return `${Math.floor(d / 365)}y ago`;
}

// Extract hostname from URL, strip www.
function hostname(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, ""); }
  catch { return url; }
}

// Format sources as bracketed list: [docs.stripe.com, github.com, +3]
function formatSources(sources: string[], maxShown: number = 3): string {
  if (!sources || sources.length === 0) return "[]";
  const seen = new Set<string>();
  const hosts: string[] = [];
  for (const s of sources) {
    const h = hostname(s);
    if (!seen.has(h)) { seen.add(h); hosts.push(h); }
  }
  if (hosts.length <= maxShown) return `[${hosts.join(", ")}]`;
  const shown = hosts.slice(0, maxShown);
  const overflow = hosts.length - maxShown;
  return `[${shown.join(", ")}, +${overflow}]`;
}

// ─────────────────────────────────────────────────────────────────
// Badge: HIT
//
// ── wellread ──
//
// ✓ @lucid-falcon-9093 already researched that
//   ↳ used 12 times
//   ↳ stable content · verified 3d ago
//   ↳ sources: [docs.stripe.com, github.com, +3]
// ⭐ you skipped 5.4K tokens
// ─────────────────────────────────────────────────────────────────

export interface HitBadgeData {
  topRawTokens: number;
  topResponseTokens: number;
  topResearchTurns: number;
  userBaseline: number;
  topVolatility: string | undefined;
  topAgeDays: number;
  createdAgeDays?: number;
  topSources: string[];
  otherDevsCount: number;
  topMatchCount: number;
  topContributorName?: string | null;
}

export function buildHitBadge(data: HitBadgeData): string {
  // Personalized savings from top result only:
  // raw_tokens (incremental research cost) + baseline × research_turns (context replay) - response_tokens
  const raw = safeInt(data.topRawTokens);
  const resp = safeInt(data.topResponseTokens);
  const bl = safeInt(data.userBaseline);
  const rt = safeInt(data.topResearchTurns);
  const skipped = (bl > 0 && rt > 0)
    ? raw + (bl * rt) - resp
    : Math.max(0, raw - resp);
  const vol = volatilityLabel(data.topVolatility);
  const age = formatAge(data.topAgeDays);
  const sources = formatSources(data.topSources);
  const reused = safeInt(data.topMatchCount);

  // Author line: check self first, then @name, then fallback "someone".
  // Includes "Xd ago" to show when the research was originally done.
  const others = safeInt(data.otherDevsCount);
  const researchedAge = formatAge(data.createdAgeDays ?? data.topAgeDays);
  let authorLine: string;
  if (others === 0) {
    authorLine = `✓ you already researched that ${researchedAge}`;
  } else if (data.topContributorName) {
    authorLine = `✓ @${data.topContributorName} already researched that ${researchedAge}`;
  } else {
    authorLine = `✓ someone already researched that ${researchedAge}`;
  }

  const usedByLine = reused > 0 ? `  ↳ used ${reused} times` : "";
  const turnsAndTokens = (skipped > 0 && rt > 0)
    ? `⭐ you skipped ${rt} turns · ${formatTokensDecimal(skipped)} tokens`
    : skipped > 0
    ? `⭐ you skipped ${formatTokensDecimal(skipped)} tokens`
    : "";

  const lines = [
    "── wellread ──",
    "",
    authorLine,
    ...(usedByLine ? [usedByLine] : []),
    `  ↳ sources: ${sources}`,
    ...(turnsAndTokens ? [turnsAndTokens] : []),
  ];
  return lines.join("\n");
}

// ─────────────────────────────────────────────────────────────────
// Badge: PARTIAL
//
// ── wellread ──
//
// ✓ @vast-narwhal-2567 already looked into this
//   ↳ used 4 times
//   ↳ volatile content · verified 1d ago
// ⭐ you skipped 3.2K tokens
//
// + You made your contribution #14 to fill the gaps
//   ↳ sources: [vercel.com, github.com, +3]
// ⭐ others will benefit from this
// ─────────────────────────────────────────────────────────────────

export interface BuiltOnBadgeData {
  startedFromCount: number;
  cachedRawTokens: number;
  cachedResponseTokens: number;
  cachedTopVolatility: string | undefined;
  cachedTopAgeDays: number;
  cachedSources: string[];
  newSources: string[];
  contributionNumber: number;
  otherDevsCount: number;
  topContributorName?: string | null;
}

export function buildBuiltOnBadge(data: BuiltOnBadgeData): string {
  const skipped = Math.max(0, safeInt(data.cachedRawTokens) - safeInt(data.cachedResponseTokens));
  const vol = volatilityLabel(data.cachedTopVolatility);
  const age = formatAge(data.cachedTopAgeDays);
  const contrib = safeInt(data.contributionNumber) || 1;
  const others = safeInt(data.otherDevsCount);
  const sources = formatSources(data.newSources);

  // Author line — same self-first logic as HIT badge, with age.
  const researchedAge = formatAge(data.cachedTopAgeDays);
  let authorLine: string;
  if (others === 0) {
    authorLine = `✓ you already looked into this ${researchedAge}`;
  } else if (data.topContributorName) {
    authorLine = `✓ @${data.topContributorName} already looked into this ${researchedAge}`;
  } else {
    authorLine = `✓ someone already looked into this ${researchedAge}`;
  }

  const skippedLine = skipped > 0 ? `⭐ you skipped ${formatTokensDecimal(skipped)} tokens` : "";

  const lines = [
    "── wellread ──",
    "",
    authorLine,
    `  ↳ ${vol} · verified ${age}`,
    ...(skippedLine ? [skippedLine] : []),
    "",
    `+ your contribution #${contrib} filled in the gaps`,
    `  ↳ sources: ${sources}`,
  ];
  return lines.join("\n");
}

// ─────────────────────────────────────────────────────────────────
// Badge: MISS
//
// ── wellread ──
//
// + No prior research found
//   ↳ You made your contribution #14
//   ↳ sources: [docs.stripe.com, github.com, +3]
// ⭐ others will benefit from this
// ─────────────────────────────────────────────────────────────────

export interface SaveBadgeData {
  sources: string[];
  contributionNumber: number;
}

export function buildSaveBadge(data: SaveBadgeData): string {
  const contrib = safeInt(data.contributionNumber) || 1;
  const sources = formatSources(data.sources);

  const lines = [
    "── wellread ──",
    "",
    `+ no prior research found · your contribution #${contrib}`,
    `  ↳ sources: ${sources}`,
  ];
  return lines.join("\n");
}
