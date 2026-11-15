// Talks to the Python agent service (deepagents + Gemini). Every call fails soft: the bridge keeps working without it.
const AGENT_URL = (process.env.AGENT_URL ?? "http://localhost:8001").replace(/\/$/, "");

async function call<T>(path: string, body?: unknown, timeoutMs = 45_000): Promise<T> {
  const res = await fetch(`${AGENT_URL}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`${path} -> HTTP ${res.status}`);
  return (await res.json()) as T;
}

export const agentClient = {
  url: AGENT_URL,
  health: () => call<{ ok: boolean; gemini: boolean }>("/health", undefined, 3000),
  event: (frame: unknown) => call("/events", frame, 5000),
  chat: (phone: string, text: string) => call<{ reply: string }>("/chat", { phone, text }),
  remember: (phone: string, text: string) => call("/remember", { phone, text }, 5000),
  alert: (a: { alert_id: string; node: string; template: string; recipients: string[] }) =>
    call<{ status: string; approval_id: number; preview: string }>("/alerts", a, 60_000),
  decide: (id: number, decision: "approve" | "edit" | "reject", text?: string) =>
    call<{ status: string }>(`/approvals/${id}`, { decision, text }, 60_000),
  photo: (p: { phone: string; image_b64: string; mime: string; node: string | null; text?: string }) =>
    call<{ reply: string }>("/photo", p, 60_000),
};
