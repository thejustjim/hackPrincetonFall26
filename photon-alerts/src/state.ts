// What the agent knows about the water right now, built from the gateway /ws feed.
import type { Decision, Reading } from "./rules.js";

export interface Report {
  type: "report";
  node: string;
  test: number;
  summary: string;
  findings?: string[];
  actions?: string[];
}

export class LiveState {
  latest = new Map<string, Reading>(); // node -> latest raw tap reading (phase "before")
  filtered = new Map<string, Reading>(); // node -> latest reading after a filter
  explanations = new Map<number, Decision>(); // reading id -> Claude's decision
  reports = new Map<string, Report>(); // node -> latest investigator report

  ingest(frame: { type?: string } & Record<string, unknown>): void {
    if (frame.type === "reading") {
      const r = frame as unknown as Reading;
      if (r.phase === "after") this.filtered.set(r.node, r);
      else {
        this.latest.set(r.node, r);
        this.filtered.delete(r.node); // a new raw test makes the old filtered result stale
      }
    } else if (frame.type === "decision") {
      const d = frame as unknown as Decision;
      this.explanations.set(d.id, d);
      if (this.explanations.size > 500) this.explanations.delete(this.explanations.keys().next().value!);
    } else if (frame.type === "report") {
      const rep = frame as unknown as Report;
      this.reports.set(rep.node, rep);
    }
  }

  /** Compact plain-text snapshot for the agent prompt. */
  snapshot(nodes: string[] | "all", now = Date.now()): string {
    const rows: string[] = [];
    for (const [node, r] of this.latest) {
      if (nodes !== "all" && !nodes.includes(node)) continue;
      const ageMin = Math.round((now - Date.parse(r.ts)) / 60_000);
      const d = this.explanations.get(r.id);
      rows.push(
        [
          `- ${r.name ?? node} (${node})${r.sim ? " [SIMULATED]" : ""}: test ${r.test} ${r.phase}, ${isFinite(ageMin) ? ageMin + " min ago" : "time unknown"}`,
          `  verdict ${r.verdict}, TDS ${Math.round(r.tds)} ppm, pH ${r.ph}, clarity ${r.clarity}, filter ${r.filter ?? "none"}${d?.ai_filter ? `, Claude's filter ${d.ai_filter}` : ""}`,
          d?.explanation || r.explanation ? `  explanation: ${d?.explanation ?? r.explanation}` : "",
          this.reports.get(node) ? `  investigator: ${this.reports.get(node)!.summary}` : "",
        ]
          .filter(Boolean)
          .join("\n"),
      );
    }
    return rows.length ? rows.join("\n") : "(no readings received yet)";
  }
}
