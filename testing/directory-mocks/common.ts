// Shared bits for the directory mocks (NAN-3503). SYNTHETIC DATA ONLY.

export type Handler = (req: Request) => Response | Promise<Response>;

export interface Served {
  method: string;
  host: string;
  path: string;
  query: Record<string, string>;
  status: number;
  count: number;
}

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
}

export function hex(n: number, width: number): string {
  return n.toString(16).padStart(width, "0");
}

/** Deterministic GUID-shaped id from a namespace digit and an index. */
export function guid(ns: number, i: number): string {
  return `${hex(ns, 8)}-0000-4000-8000-${hex(i, 12)}`;
}

/** Host the client meant: the loopback runner keeps it in X-Forwarded-Host or Host. */
export function hostOf(req: Request, url: URL): string {
  return req.headers.get("x-forwarded-host") ?? req.headers.get("x-original-host") ?? req.headers.get("host") ?? url.host;
}

/** Decode a JWT payload without verifying it (the mocks only record claims). */
export function jwtClaims(token: string): Record<string, unknown> {
  const part = token.split(".")[1] ?? "";
  try {
    const b64 = part.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(part.length / 4) * 4, "=");
    return JSON.parse(atob(b64));
  } catch {
    return {};
  }
}

/** One-shot fault switch shared by the mocks: the next N requests answer 429. */
export class Faults {
  remaining429 = 0;
  retryAfterSecs = 1;
  unauthorized = false;
  /** Arm `n` 429 answers carrying Retry-After = `retryAfterSecs`. */
  throttle(n: number, retryAfterSecs = 1): void {
    this.remaining429 = n;
    this.retryAfterSecs = retryAfterSecs;
  }
  take429(): boolean {
    if (this.remaining429 <= 0) return false;
    this.remaining429--;
    return true;
  }
}

/** One recorded exchange in nano-connector's preview format
 *  (nano-connector/src/preview.rs `Recorded`): lane A's Rust tests and
 *  `nano-connector preview <spec> <recording.json>` load these directly. */
export interface Recorded {
  method?: string;
  host: string;
  path: string;
  query?: Record<string, string>;
  status?: number;
  headers?: Record<string, string>;
  body: unknown;
}

/** Call a handler in-process and capture the exchange as a recording entry. */
export async function record(
  handler: Handler,
  url: string,
  init: RequestInit = {},
  matchQuery: string[] | "all" = "all",
): Promise<Recorded> {
  const req = new Request(url, init);
  const res = await handler(req);
  const u = new URL(url);
  const q = Object.fromEntries(u.searchParams.entries());
  const query = matchQuery === "all" ? q : Object.fromEntries(Object.entries(q).filter(([k]) => matchQuery.includes(k)));
  const headers: Record<string, string> = {};
  res.headers.forEach((v, k) => {
    if (k !== "content-type") headers[k] = v;
  });
  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch { /* keep text */ }
  const out: Recorded = { method: req.method, host: u.hostname, path: u.pathname, status: res.status, body };
  if (Object.keys(query).length) out.query = query;
  if (Object.keys(headers).length) out.headers = headers;
  return out;
}
