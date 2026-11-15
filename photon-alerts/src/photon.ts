// Photon (Spectrum) sender: sends iMessage, falling back to SMS where Photon routes it.
// Docs: https://photon.codes/docs/spectrum-ts/getting-started
import { Spectrum } from "spectrum-ts";
import { imessage } from "spectrum-ts/providers/imessage";
import type { Sender } from "./alerter.js";
import { scrub as scrubOut } from "./safety.js";

type App = Awaited<ReturnType<typeof Spectrum>>;

export interface Inbound {
  phone: string;
  text?: string;
  image?: { b64: string; mime: string };
}

export class PhotonSender implements Sender {
  private queues = new Map<string, Promise<void>>();
  private constructor(private app: App) {}

  static async connect(): Promise<PhotonSender> {
    const projectId = process.env.SPECTRUM_PROJECT_ID;
    const projectSecret = process.env.SPECTRUM_PROJECT_SECRET;
    if (!projectId || !projectSecret) {
      throw new Error("Set SPECTRUM_PROJECT_ID and SPECTRUM_PROJECT_SECRET (or DRY_RUN=1)");
    }
    const app = await Spectrum({ projectId, projectSecret, providers: [imessage.config()] });
    return new PhotonSender(app);
  }

  async send(to: string, text: string): Promise<void> {
    const im = imessage(this.app);
    // Reuse the DM if this person already texted the line (opt-in), otherwise open one.
    let space;
    try {
      space = await im.space.get(`any;-;${to}`);
    } catch {
      space = undefined;
    }
    if (!space) {
      const user = await im.user(to);
      space = await im.space.create(user);
    }
    await space.send(text);
  }

  /** Inbound texts and photos. Calls back with the sender's phone, the text and any image. */
  async listen(onMessage: (m: Inbound) => Promise<string | null>): Promise<void> {
    console.log("[photon] listening for incoming texts");
    for await (const [space, message] of this.app.messages) {
      if (message.direction === "outbound") continue;
      const sender = message.sender as { id?: string; address?: string } | undefined;
      const phone = sender?.address ?? sender?.id ?? (space as { id?: string }).id;
      if (!phone) {
        console.log("[photon] incoming message with no sender, skipped");
        continue;
      }
      const c = message.content;
      let inbound: Inbound | null = null;
      if (c.type === "text") inbound = { phone, text: c.text };
      else if (c.type === "attachment" && c.mimeType.startsWith("image/")) {
        try {
          const buf = await c.read();
          inbound = { phone, image: { b64: buf.toString("base64"), mime: c.mimeType } };
        } catch (err) {
          console.error("[photon] couldn't read photo:", (err as Error).message);
          await space.send("📷 I couldn't open that photo. Try sending it again.").catch(() => {});
          continue;
        }
      }
      if (!inbound) {
        console.log(`[photon] skipped ${c.type} message`);
        // Videos, files, voice notes: say what we can take instead of going silent.
        if (c.type === "attachment") await space.send("📷 I can read texts and photos. Send a photo of a glass of your water, or ask me a question.").catch(() => {});
        continue;
      }
      // Answer each person in parallel (Gemini can take a few seconds), but keep one person's replies in order.
      const msg = inbound;
      const prev = this.queues.get(phone) ?? Promise.resolve();
      const next = prev.then(async () => {
        try {
          const reply = await onMessage(msg);
          if (reply) await space.send(scrubOut(reply));
        } catch (err) {
          console.error("[photon] inbound handler failed:", (err as Error).message);
        }
      });
      this.queues.set(phone, next);
      void next.finally(() => this.queues.get(phone) === next && this.queues.delete(phone));
    }
  }

  async stop(): Promise<void> {
    await this.app.stop();
  }
}

/** DRY_RUN sender: prints what would be texted. */
export class ConsoleSender implements Sender {
  public sent: { to: string; text: string }[] = [];
  async send(to: string, text: string): Promise<void> {
    this.sent.push({ to, text });
    console.log(`\n──── SMS to ${to} ────\n${text}\n────────────────────`);
  }
}
