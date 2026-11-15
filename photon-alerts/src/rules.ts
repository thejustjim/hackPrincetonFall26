// Contamination rules for Clarity readings.
// Reading shape: see gateway /ws `type:"reading"` (Jim's spec).

export type Verdict = "SAFE" | "HIGH_TDS" | "CLOUDY" | "PH_WARN";
export type FilterName = "ZEROWATER" | "BRITA" | "NONE";

export interface Reading {
  type?: "reading";
  id: number;
  ts: string;
  node: string;
  name?: string;
  test: number;
  phase: "before" | "after";
  ph: number;
  ph_est?: boolean | 0 | 1 | null;
  tds: number;
  clarity: number;
  verdict: Verdict;
  filter: FilterName | null;
  ai_filter: FilterName | null;
  rssi?: number;
  lat?: number;
  lon?: number;
  sim: boolean;
  anomaly?: number;
  explanation: string | null;
}

/** Explicit per-reading provenance wins. Older firmware falls back to the deployment setting. */
export function phIsEstimated(r: Pick<Reading, "ph_est">): boolean {
  if (r.ph_est === false || r.ph_est === 0) return false;
  if (r.ph_est === true || r.ph_est === 1) return true;
  return process.env.PH_ESTIMATED !== "0";
}

export interface Decision {
  type: "decision";
  id: number;
  node: string;
  test: number;
  phase: "before" | "after";
  ai_filter: FilterName | null;
  explanation: string | null;
  source: "claude" | "local_rule";
}

export type Severity = "ok" | "warning" | "unsafe";

export const LIMITS = {
  TDS_EPA: 500, // EPA secondary limit, ppm
  TDS_HIGH: 300, // comfort level, ppm
  PH_MIN: 6.5,
  PH_MAX: 8.5,
};

export interface Assessment {
  severity: Severity;
  reasons: string[];
}

/**
 * unsafe  = TDS above the EPA 500 ppm limit, or measured pH outside 6.5 to 8.5.
 * warning = any other non-SAFE verdict (HIGH_TDS 300-500 ppm, CLOUDY).
 * ok      = SAFE verdict and inside all limits.
 */
export function assess(r: Reading): Assessment {
  const reasons: string[] = [];
  let severity: Severity = "ok";
  const estimated = phIsEstimated(r);

  if (r.tds > LIMITS.TDS_EPA) {
    severity = "unsafe";
    reasons.push(`TDS ${Math.round(r.tds)} ppm (EPA limit ${LIMITS.TDS_EPA})`);
  }
  if (!estimated && (r.ph < LIMITS.PH_MIN || r.ph > LIMITS.PH_MAX)) {
    severity = "unsafe";
    reasons.push(`pH ${r.ph.toFixed(1)} (normal ${LIMITS.PH_MIN}-${LIMITS.PH_MAX})`);
  }
  const highTds = r.tds > LIMITS.TDS_HIGH || r.verdict === "HIGH_TDS";
  const cloudy = r.clarity < 0.7 || r.verdict === "CLOUDY";
  const phWarning = !estimated && r.verdict === "PH_WARN";
  if (highTds || cloudy || phWarning) {
    if (severity === "ok") severity = "warning";
    if (highTds && r.tds <= LIMITS.TDS_EPA)
      reasons.push(`TDS ${Math.round(r.tds)} ppm (above ${LIMITS.TDS_HIGH} comfort level)`);
    if (cloudy)
      reasons.push(`cloudy water (clarity ${Math.round(r.clarity * 100)}%)`);
    if (phWarning && !reasons.some((x) => x.startsWith("pH")))
      reasons.push(`pH ${r.ph.toFixed(1)} flagged`);
  }
  return { severity, reasons };
}

export const SEVERITY_RANK: Record<Severity, number> = { ok: 0, warning: 1, unsafe: 2 };
