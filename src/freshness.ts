export type Volatility = "timeless" | "stable" | "evolving" | "volatile";
export type FreshnessLabel = "fresh" | "check" | "stale";

export interface FreshnessResult {
  label: FreshnessLabel;
  age_days: number;
}

export const VOLATILITY_WINDOWS: Record<Volatility, { fresh_days: number; check_days: number }> = {
  timeless: { fresh_days: 365, check_days: Infinity },
  stable:   { fresh_days: 180, check_days: 365 },
  evolving: { fresh_days: 30,  check_days: 90 },
  volatile: { fresh_days: 7,   check_days: 30 },
};

export const VALID_VOLATILITIES: Volatility[] = ["timeless", "stable", "evolving", "volatile"];
export const DEFAULT_VOLATILITY: Volatility = "stable";

export function computeFreshness(
  volatility: Volatility,
  createdAt: string | Date,
  lastVerifiedAt: string | Date | null,
  now: Date = new Date()
): FreshnessResult {
  const created = new Date(createdAt);
  const reference = lastVerifiedAt
    ? new Date(Math.max(new Date(lastVerifiedAt).getTime(), created.getTime()))
    : created;
  const age_days = Math.floor((now.getTime() - reference.getTime()) / (1000 * 60 * 60 * 24));
  const config = VOLATILITY_WINDOWS[volatility] ?? VOLATILITY_WINDOWS.stable;

  let label: FreshnessLabel;
  if (age_days <= config.fresh_days) label = "fresh";
  else if (age_days <= config.check_days) label = "check";
  else label = "stale";

  return { label, age_days };
}
