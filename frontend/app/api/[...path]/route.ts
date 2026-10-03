import type { NextRequest } from "next/server";

/**
 * Same-origin gateway to the FastAPI backend. The browser only ever talks to
 * this app, so the session cookie stays first-party, and the backend is never
 * exposed directly. API_URL is read at runtime.
 */
export const dynamic = "force-dynamic";

const API = (process.env.API_URL || "http://localhost:8001").replace(/\/$/, "");
const TIMEOUT_MS = 180_000;  // Gemma can take a while to answer
const DROP_REQUEST = ["host", "connection", "content-length", "transfer-encoding", "keep-alive", "upgrade"];
const DROP_RESPONSE = ["content-encoding", "content-length", "transfer-encoding", "connection", "keep-alive", "set-cookie"];

async function forward(request: NextRequest, context: { params: Promise<{ path: string[] }> }) {
  const { path } = await context.params;
  const target = `${API}/api/${path.map(encodeURIComponent).join("/")}${request.nextUrl.search}`;

  const headers = new Headers(request.headers);
  DROP_REQUEST.forEach((name) => headers.delete(name));
  const hasBody = !["GET", "HEAD"].includes(request.method);

  let upstream: Response;
  try {
    upstream = await fetch(target, {
      method: request.method,
      headers,
      body: hasBody ? await request.arrayBuffer() : undefined,
      redirect: "manual",
      cache: "no-store",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    const timedOut = err instanceof Error && err.name === "TimeoutError";
    return Response.json(
      { detail: timedOut ? "That took too long. Please try again." : "The server is starting up or unreachable. Please try again in a moment." },
      { status: timedOut ? 504 : 502 },
    );
  }

  const out = new Headers();
  upstream.headers.forEach((value, name) => { if (!DROP_RESPONSE.includes(name)) out.set(name, value); });
  upstream.headers.getSetCookie().forEach((cookie) => out.append("set-cookie", cookie));
  const empty = [204, 205, 304].includes(upstream.status) || request.method === "HEAD";
  return new Response(empty ? null : upstream.body, { status: upstream.status, headers: out });
}

export { forward as GET, forward as POST, forward as PATCH, forward as PUT, forward as DELETE };
