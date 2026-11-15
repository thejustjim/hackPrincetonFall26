import { assess, SEVERITY_RANK, type Decision, type Reading, type Severity } from "./rules.js";
import { contaminationAlert, reminderMessage, retestMessage } from "./messages.js";
import type { SubscriberStore } from "./subscribers.js";

export interface Sender {
  send(to: string, text: string): Promise<void>;
}

export interface OutgoingAlert {
  alertId: string;
  node: string;
  severity: Severity;
  text: string; // fixed template
  recipients: string[];
}

/**
 * Hands an alert off for delivery. The default sends right away; with the Python agent it goes to
 * Gemini for wording and waits for operator approval, and the agent later calls back to actually send.
 */
export type Dispatch = (alert: OutgoingAlert) => Promise<void>;

export interface AlerterOptions {
  minSeverity?: Exclude<Severity, "ok">;
  cooldownMs?: number;
  decisionWaitMs?: number;
  includeSim?: boolean;
  /** Re-text people who haven't replied to a failed-test alert after this long. 0 = off. */
  remindAfterMs?: number;
  dispatch?: Dispatch;
  /** Called for every text actually sent (so the agent can remember what it told whom). */
  onSent?: (to: string, text: string) => void;
  log?: (msg: string) => void;
  now?: () => number;
}

interface Pending {
  reading: Reading;
  timer: ReturnType<typeof setTimeout>;
}

export class Alerter {
  private opts: Required<AlerterOptions>;
  private pending = new Map<number, Pending>();
  private lastAlert = new Map<string, { at: number; severity: Severity }>();
  private alertedTests = new Map<string, Reading>();
  private awaitingAck = new Map<string, { node: string; at: number; reminded: boolean }>();
  /** alertId -> what it was about, so a delayed (approved) send can be tracked. */
  readonly outgoing = new Map<string, OutgoingAlert>();
  private seq = 0;

  constructor(private sender: Sender, private subs: SubscriberStore, opts: AlerterOptions = {}) {
    this.opts = {
      minSeverity: opts.minSeverity ?? "warning",
      cooldownMs: opts.cooldownMs ?? 10 * 60_000,
      decisionWaitMs: opts.decisionWaitMs ?? 8_000,
      includeSim: opts.includeSim ?? false,
      remindAfterMs: opts.remindAfterMs ?? 15 * 60_000,
      dispatch: opts.dispatch ?? ((a) => this.deliver(a.alertId, a.recipients, a.text).then(() => {})),
      onSent: opts.onSent ?? (() => {}),
      log: opts.log ?? ((m) => console.log(m)),
      now: opts.now ?? Date.now,
    };
  }

  async handle(frame: { type?: string } & Record<string, unknown>): Promise<void> {
    if (frame.type === "reading") return this.onReading(frame as unknown as Reading);
    if (frame.type === "decision") return this.onDecision(frame as unknown as Decision);
  }

  async onReading(r: Reading): Promise<void> {
    if (r.sim && !this.opts.includeSim) return;
    const a = assess(r);
    const key = `${r.node}#${r.test}`;

    if (r.phase === "after") {
      const before = this.alertedTests.get(key);
      const stillBad = SEVERITY_RANK[a.severity] >= SEVERITY_RANK[this.opts.minSeverity];
      if (!before && !stillBad) return;
      this.alertedTests.delete(key);
      if (a.severity === "ok") for (const [p, w] of this.awaitingAck) if (w.node === r.node) this.awaitingAck.delete(p);
      await this.broadcast(r.node, a.severity, retestMessage(before, r, a));
      return;
    }

    if (SEVERITY_RANK[a.severity] < SEVERITY_RANK[this.opts.minSeverity]) return;

    const last = this.lastAlert.get(r.node);
    const now = this.opts.now();
    if (last && now - last.at < this.opts.cooldownMs && SEVERITY_RANK[a.severity] <= SEVERITY_RANK[last.severity]) {
      this.opts.log(`[alert] ${r.node} test ${r.test}: ${a.severity}, in cooldown, skipped`);
      return;
    }
    this.lastAlert.set(r.node, { at: now, severity: a.severity });
    this.alertedTests.set(key, r);

    if (r.explanation) return this.sendAlert(r, r.explanation);
    const timer = setTimeout(() => {
      this.pending.delete(r.id);
      void this.sendAlert(r, null);
    }, this.opts.decisionWaitMs);
    this.pending.set(r.id, { reading: r, timer });
  }

  async onDecision(d: Decision): Promise<void> {
    const p = this.pending.get(d.id);
    if (!p) return;
    clearTimeout(p.timer);
    this.pending.delete(d.id);
    await this.sendAlert({ ...p.reading, ai_filter: d.ai_filter ?? p.reading.ai_filter }, d.explanation);
  }

  private async sendAlert(r: Reading, explanation: string | null): Promise<void> {
    await this.broadcast(r.node, assess(r).severity, contaminationAlert(r, assess(r), explanation));
  }

  private async broadcast(node: string, severity: Severity, text: string): Promise<void> {
    const recipients = this.subs.recipientsFor(node);
    if (recipients.length === 0) {
      this.opts.log(`[alert] ${node}: no subscribers, not sent:\n${text}`);
      return;
    }
    const alert: OutgoingAlert = { alertId: `${node}-${++this.seq}-${this.opts.now()}`, node, severity, text, recipients };
    this.outgoing.set(alert.alertId, alert);
    try {
      await this.opts.dispatch(alert);
    } catch (err) {
      this.opts.log(`[alert] dispatch failed for ${node}: ${(err as Error).message}`);
    }
  }

  /** Actually text an alert (now, or later once an operator approves). Returns phones reached. */
  async deliver(alertId: string | null, recipients: string[], text: string): Promise<string[]> {
    const meta = alertId ? this.outgoing.get(alertId) : undefined;
    const sent: string[] = [];
    await Promise.all(
      recipients.map(async (phone) => {
        try {
          await this.sender.send(phone, text);
          sent.push(phone);
          this.opts.onSent(phone, text);
          this.opts.log(`[alert] sent to ${mask(phone)}${meta ? ` (${meta.node})` : ""}`);
        } catch (err) {
          this.opts.log(`[alert] FAILED to ${mask(phone)}: ${(err as Error).message}`);
        }
      }),
    );
    if (meta?.severity === "unsafe" && !/Retest|Still failing/.test(text.slice(0, 40))) {
      for (const phone of sent) this.awaitingAck.set(phone, { node: meta.node, at: this.opts.now(), reminded: false });
    }
    return sent;
  }

  acknowledge(phone: string): string | null {
    const w = this.awaitingAck.get(phone);
    this.awaitingAck.delete(phone);
    return w?.node ?? null;
  }

  /** The site this person was most recently alerted about (for attaching their photos). */
  lastNodeFor(phone: string): string | null {
    return this.awaitingAck.get(phone)?.node ?? null;
  }

  async sendReminders(): Promise<void> {
    if (!this.opts.remindAfterMs) return;
    const now = this.opts.now();
    for (const [phone, w] of this.awaitingAck) {
      if (w.reminded || now - w.at < this.opts.remindAfterMs) continue;
      w.reminded = true;
      const text = reminderMessage(w.node);
      try {
        await this.sender.send(phone, text);
        this.opts.onSent(phone, text);
        this.opts.log(`[alert] reminder sent to ${mask(phone)} (${w.node})`);
      } catch (err) {
        this.opts.log(`[alert] reminder FAILED to ${mask(phone)}: ${(err as Error).message}`);
      }
    }
  }

  close(): void {
    for (const p of this.pending.values()) clearTimeout(p.timer);
    this.pending.clear();
  }
}

export function mask(phone: string): string {
  return phone.length > 4 ? `${"•".repeat(phone.length - 4)}${phone.slice(-4)}` : phone;
}
