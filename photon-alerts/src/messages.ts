import { assess, type Assessment, type FilterName, type Reading } from "./rules.js";

// Texts are read on a phone lock screen: short lines, one status emoji, no repeated ids.
const FILTER_LABEL: Record<FilterName, string> = { ZEROWATER: "ZeroWater", BRITA: "Brita", NONE: "none" };

export function site(r: { name?: string | null; node: string; sim?: boolean }): string {
  return `${r.name || r.node}${r.sim ? " (simulated)" : ""}`;
}

// One plain-language line under each failed reading: what it is and why it matters.
const WHY = {
  tds: "↳ dissolved salts & metals. High = bad taste, scale, and it can carry contaminants",
  phLow: "↳ acidic water can pull lead and copper out of pipes",
  phHigh: "↳ alkaline water tastes bitter and leaves scale",
  cloudy: "↳ particles that can hide bacteria",
};

function metricLines(r: Reading, explain = true): string[] {
  const tdsBad = r.tds > 300;
  const phBad = r.ph < 6.5 || r.ph > 8.5;
  const lines = [`TDS ${Math.round(r.tds)} ppm ${tdsBad ? `⚠️ (limit ${r.tds > 500 ? 500 : 300})` : "✓"}`];
  if (tdsBad && explain) lines.push(WHY.tds);
  lines.push(`pH ${r.ph.toFixed(1)} ${phBad ? "⚠️ (normal 6.5–8.5)" : "✓"}`);
  if (phBad && explain) lines.push(r.ph < 6.5 ? WHY.phLow : WHY.phHigh);
  if (r.verdict === "CLOUDY") {
    lines.push(`Clarity ${Math.round(r.clarity * 100)}% ⚠️ cloudy`);
    if (explain) lines.push(WHY.cloudy);
  }
  return lines;
}

/** INFO: what each test means. */
export const INFO_TEXT = [
  "💧 What Clarity tests",
  "",
  "TDS (ppm): dissolved salts & metals. Normal under 300, EPA limit 500. High = bad taste, scale, possible contaminants.",
  "",
  "pH: acidity. Normal 6.5–8.5. Low pH can pull lead & copper from pipes.",
  "",
  "Clarity (%): how clear it is. Cloudy water has particles that can hide bacteria.",
  "",
  "Retest = same water after a filter, to show if the filter fixes it.",
  "Note: these sensors can't detect lead, bacteria or PFAS directly.",
].join("\n");

/** First alert for a failed reading. */
export function contaminationAlert(r: Reading, a: Assessment, _explanation: string | null): string {
  const sim = r.sim ? " (simulated)" : "";
  const head = a.severity === "unsafe" ? `🚨 Water alert · Clarity${sim}` : `⚠️ Water notice · Clarity${sim}`;
  const filter = r.ai_filter ?? r.filter;
  const lines = [head, "", ...metricLines(r)];
  if (filter && filter !== "NONE") lines.push(`Use: ${FILTER_LABEL[filter]} filter`);
  lines.push("");
  if (a.severity === "unsafe") lines.push("Don't drink it unfiltered.", "Reply OK · INFO · STOP");
  else lines.push("Ask me anything · INFO · STOP");
  return lines.join("\n");
}

/** Follow-up after the post-filter ("after") retest of the same test number. */
export function retestMessage(before: Reading | undefined, after: Reading, a: Assessment): string {
  const filter = after.filter && after.filter !== "NONE" ? FILTER_LABEL[after.filter] : "filter";
  const delta = before ? `TDS ${Math.round(before.tds)} → ${Math.round(after.tds)} ppm with ${filter}` : `TDS ${Math.round(after.tds)} ppm after ${filter}`;
  const pct = before && before.tds > 0 ? Math.round((1 - after.tds / before.tds) * 100) : null;
  const removed = pct !== null && pct > 0 ? [`↳ the filter removed ${pct}% of dissolved solids`] : [];
  if (a.severity === "ok") return [`✅ Retest · Clarity${after.sim ? " (simulated)" : ""}`, "", delta, ...removed, "Back within normal range."].join("\n");
  return [`🚨 Still failing · Clarity${after.sim ? " (simulated)" : ""}`, "", delta, ...metricLines(after, false).filter((l) => l.includes("⚠️") && !l.startsWith("TDS")), "", "Don't drink it. Try another filter or replace the cartridge."]
    .filter((l, i, arr) => !(l === "" && arr[i - 1] === ""))
    .join("\n");
}

/** Compact status of several sites, for replies when the assistant is offline. */
export function readingsSummary(readings: Reading[], filtered: Map<string, Reading> = new Map()): string {
  if (!readings.length) return "💧 No readings yet.\nText JOIN for alerts · STOP to opt out";
  const rows = readings.map((r) => {
    const icon = assess(r).severity === "ok" ? "✅" : assess(r).severity === "unsafe" ? "🚨" : "⚠️";
    const f = filtered.get(r.node);
    const after = f ? `\n   ↳ filtered: TDS ${Math.round(f.tds)} ${assess(f).severity === "ok" ? "✓" : "⚠️"}` : "";
    return `${icon} ${site(r)}: TDS ${Math.round(r.tds)} · pH ${r.ph.toFixed(1)}${after}`;
  });
  return ["💧 Latest readings", "", ...rows].join("\n");
}

export function reminderMessage(node: string): string {
  void node;
  return [`⏰ Reminder · Clarity`, "", "Last test failed. Don't drink it unfiltered.", "Reply OK once you've seen this."].join("\n");
}

export function approvalRequest(id: number, count: number, node: string, preview: string): string {
  return [`🔔 Approve #${id}? → ${count} ${count === 1 ? "person" : "people"} · ${node}`, "", preview, "", `APPROVE ${id} · REJECT ${id} · EDIT ${id}`].join("\n");
}

export const WELCOME = [
  "💧 Hi, I'm Clarity",
  "",
  "I watch your water tests and text you here if one fails. STOP anytime.",
  "",
  "Ask me things like:",
  "• is my water ok?",
  "• what's TDS?",
  "• do I need a new filter?",
  "Or send a photo of a glass of your water.",
].join("\n");
