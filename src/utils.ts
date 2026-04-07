// --- Impact calculation (per token: 0.005 mL water) ---
export function waterSaved(tokens: number): string {
  const ml = tokens * 0.005;
  if (ml < 1000) return `${ml.toFixed(0)} mL of water`;
  return `${(ml / 1000).toFixed(1)} L of water`;
}

// --- Token formatting (K for thousands, M for millions) ---
export function formatTokens(tokens: number): string {
  // 950K+ rounds up to 1M to avoid the awkward "~1000K"
  if (tokens >= 950_000) {
    const m = tokens / 1_000_000;
    // 1 decimal for sub-10M, 0 decimals for 10M+
    return m >= 10 ? `~${m.toFixed(0)}M` : `~${m.toFixed(1)}M`;
  }
  if (tokens >= 1000) return `~${(tokens / 1000).toFixed(0)}K`;
  return `~${tokens}`;
}

// --- Compression ratio ---
export function compressionPercent(rawTokens: number, responseTokens: number): number {
  if (rawTokens === 0) return 0;
  return Math.round((1 - responseTokens / rawTokens) * 100);
}

// --- Random pick from array ---
export function randomPick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}
