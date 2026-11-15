import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { INFO_TEXT } from "./messages.js";

/** phone (E.164) -> list of node ids, or ["*"] for every node. */
type Data = Record<string, string[]>;

export class SubscriberStore {
  private data: Data = {};

  /**
   * @param file    JSON file for people who opted in by texting JOIN (null = memory only)
   * @param seeded  numbers from ALERT_NUMBERS, always alerted for every node
   */
  constructor(private file: string | null, private seeded: string[] = []) {
    if (file && existsSync(file)) this.data = JSON.parse(readFileSync(file, "utf8"));
  }

  recipientsFor(node: string): string[] {
    // Preset numbers get everything unless they texted STOP (stored as an empty list).
    const out = new Set(this.seeded.filter((p) => !(p in this.data) || this.data[p].length > 0));
    for (const [phone, nodes] of Object.entries(this.data)) {
      if (nodes.includes("*") || nodes.includes(node)) out.add(phone);
    }
    return [...out];
  }

  subscribe(phone: string, node = "*"): void {
    const cur = new Set(this.data[phone] ?? []);
    if (node === "*") cur.clear();
    cur.add(node);
    this.data[phone] = [...cur];
    this.save();
  }

  unsubscribe(phone: string): void {
    this.data[phone] = []; // keep the record so we never auto-subscribe someone who said STOP
    this.save();
  }

  /** Never texted us before (and not a preset number). */
  isNew(phone: string): boolean {
    return !(phone in this.data) && !this.seeded.includes(phone);
  }

  list(phone: string): string[] {
    return this.data[phone] ?? (this.seeded.includes(phone) ? ["*"] : []);
  }

  private save(): void {
    if (this.file) writeFileSync(this.file, JSON.stringify(this.data, null, 2));
  }
}

/** Phone in E.164, or an iMessage email handle (people often text from their Apple ID email). */
export function normalizePhone(raw: string): string | null {
  const s = raw.trim().replace(/^(any|iMessage|SMS|RCS);-;/i, "").replace(/^(tel|mailto):/i, "");
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) return s.toLowerCase();
  const digits = s.replace(/[^\d+]/g, "");
  if (/^\+[1-9]\d{6,14}$/.test(digits)) return digits;
  if (/^\d{10}$/.test(digits)) return `+1${digits}`; // US default
  if (/^1\d{10}$/.test(digits)) return `+${digits}`;
  return null;
}

/**
 * Deterministic commands (JOIN/STOP/STATUS/HELP). These never go through the AI, so opt-out always works.
 * Returns null when the text isn't a command, so the agent can answer it.
 */
export function handleCommand(store: SubscriberStore, phone: string, body: string): string | null {
  const words = body.trim().split(/\s+/);
  if (words.length > 2) return null;
  const [cmd, arg] = words;
  switch ((cmd ?? "").toUpperCase()) {
    case "JOIN":
    case "START":
    case "SUBSCRIBE":
      store.subscribe(phone, arg ?? "*");
      return `✅ Subscribed to ${arg ?? "all sites"}\nReply STOP to opt out`;
    case "STOP":
    case "UNSUBSCRIBE":
      store.unsubscribe(phone);
      return "👋 Unsubscribed. Reply JOIN to come back.";
    case "INFO":
    case "WHAT":
    case "TESTS":
      return INFO_TEXT;
    case "HELP":
      return "💧 Clarity\nJOIN · JOIN <site> · STATUS · INFO · STOP\nOr ask me anything about your water.";
    case "STATUS": {
      const nodes = store.list(phone);
      return nodes.length ? `🔔 Alerts on: ${nodes.join(", ").replace("*", "all sites")}` : "🔕 Not subscribed. Reply JOIN.";
    }
    default:
      return null;
  }
}
