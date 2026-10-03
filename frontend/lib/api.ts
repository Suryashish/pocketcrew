export class ApiError extends Error {
  constructor(message: string, public status: number) {
    super(message);
  }
}

/** Call the PocketCrew API. Throws ApiError with a message that is safe to show. */
export async function api<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  const init: RequestInit = { method, credentials: "same-origin", headers: {} };
  if (body instanceof FormData) {
    init.body = body;
  } else if (body !== undefined) {
    init.headers = { "Content-Type": "application/json" };
    init.body = JSON.stringify(body);
  }
  let res: Response;
  try {
    res = await fetch(path, init);
  } catch {
    throw new ApiError("Can't reach the server. Check your connection.", 0);
  }
  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    /* empty or non-JSON body */
  }
  if (!res.ok) {
    const detail = (data as { detail?: unknown } | null)?.detail;
    const message =
      typeof detail === "string" ? detail
      : `Request failed (${res.status})`;
    throw new ApiError(message, res.status);
  }
  return data as T;
}

export const errorText = (err: unknown) => (err instanceof Error ? err.message : "Something went wrong.");

export type User = { id: number; email: string };
export type Agent = { id: number; name: string; emoji: string; role: string; instructions: string; tools: boolean };
export type AgentDraft = Omit<Agent, "id">;
export type Doc = { id: number; title: string; chars: number };
export type Memory = { id: number; text: string };
export type ChatMessage = { role: "user" | "assistant" | "note" | "thinking"; content: string };
export type ComputerState = { available: boolean; exists: boolean; preview: string };
export type TelegramLink = { id: number; display: string };
export type TelegramState = { configured: boolean; bot: string; links: TelegramLink[] };
export type LinkOffer = { url: string; qr: string; minutes: number };
export type Status = {
  llm: { model: string; reachable: boolean; model_ready: boolean; key_missing: boolean };
  telegram: { configured: boolean; bot: string };
  sandbox: { available: boolean };
  signups: boolean;
};
