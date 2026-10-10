// Vendor mocks for the shadow runs that have no standalone mock of their own
// (Okta: testing/okta-mock, Netskope: testing/netskope-mock). SYNTHETIC DATA.

import { json, mockHost } from "./lib.ts";

// ------------------------------------------------------------ Google Workspace

export function gwsEvent(app: string, i: number, t: Date): Record<string, unknown> {
  return {
    kind: "admin#reports#activity",
    id: { time: t.toISOString(), uniqueQualifier: `${app.length}${String(i).padStart(6, "0")}`, applicationName: app, customerId: "C0mock" },
    actor: { email: `user${i % 17}@example.com`, profileId: `1${String(i % 17).padStart(8, "0")}` },
    ipAddress: `203.0.113.${(i % 250) + 1}`,
    events: [{ type: app, name: i % 5 === 0 ? "login_failure" : "login_success" }],
  };
}

const b64urlDecode = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));

/**
 * Admin SDK Reports API: the RS256 service-account token exchange (signature
 * verified against `publicKey`) and activities newest first, startTime
 * inclusive, endTime exclusive, nextPageToken paging (100 per page).
 */
export function gwsMock(apps: Record<string, Record<string, unknown>[]>, publicKey: CryptoKey, expect: { iss: string; sub: string; scope: string }) {
  let tokens = 0;
  return async (req: Request): Promise<Response> => {
    const host = mockHost(req);
    const url = new URL(req.url);
    if (host === "oauth2.googleapis.com" && url.pathname === "/token") {
      const form = new URLSearchParams(await req.text());
      const parts = (form.get("assertion") ?? "").split(".");
      const ok = parts.length === 3 && form.get("grant_type") === "urn:ietf:params:oauth:grant-type:jwt-bearer" &&
        await crypto.subtle.verify("RSASSA-PKCS1-v1_5", publicKey, b64urlDecode(parts[2]), new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
      const claims = ok ? JSON.parse(new TextDecoder().decode(b64urlDecode(parts[1]))) : {};
      if (!ok || claims.iss !== expect.iss || claims.sub !== expect.sub || claims.scope !== expect.scope || claims.aud !== "https://oauth2.googleapis.com/token") {
        return json({ error: "invalid_grant" }, 400);
      }
      return json({ access_token: `ya29.mock-${tokens++}`, expires_in: 3600, token_type: "Bearer" });
    }
    if (!(req.headers.get("authorization") ?? "").startsWith("Bearer ya29.mock-")) return json({ error: { code: 401 } }, 401);
    const prefix = "/admin/reports/v1/activity/users/all/applications/";
    if (host !== "admin.googleapis.com" || !url.pathname.startsWith(prefix)) return json({}, 404);
    const all = apps[url.pathname.slice(prefix.length)];
    if (!all) return json({ error: { message: "Invalid value for applicationName" } }, 400);
    const ms = (k: string) => (url.searchParams.get(k) ? Date.parse(url.searchParams.get(k)!) : NaN);
    const start = ms("startTime"), end = ms("endTime");
    const id = (e: Record<string, unknown>) => e.id as { time: string; uniqueQualifier: string };
    const matching = all
      .filter((e) => {
        const t = Date.parse(id(e).time);
        return (isNaN(start) || t >= start) && (isNaN(end) || t < end);
      })
      .sort((a, b) => id(b).time.localeCompare(id(a).time) || id(b).uniqueQualifier.localeCompare(id(a).uniqueQualifier));
    const page = Math.min(100, Number(url.searchParams.get("maxResults") ?? "1000"));
    const off = Number((url.searchParams.get("pageToken") ?? "pt-0").slice(3)) || 0;
    const items = matching.slice(off, off + page);
    const body: Record<string, unknown> = { kind: "admin#reports#activities" };
    if (items.length > 0) body.items = items;
    if (off + page < matching.length) body.nextPageToken = `pt-${off + page}`;
    return json(body);
  };
}

/** A fresh RSA key pair plus its PKCS#8 PEM, for the service-account flow. */
export async function serviceAccountKey(): Promise<{ pem: string; publicKey: CryptoKey }> {
  const kp = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  );
  const der = new Uint8Array(await crypto.subtle.exportKey("pkcs8", kp.privateKey));
  const b64 = btoa(String.fromCharCode(...der));
  const pem = `-----BEGIN PRIVATE KEY-----\n${b64.match(/.{1,64}/g)!.join("\n")}\n-----END PRIVATE KEY-----\n`;
  return { pem, publicKey: kp.publicKey };
}

// ----------------------------------------------------------------- Slack

export function slackLogin(i: number, t: number): Record<string, unknown> {
  return {
    user_id: `U${String(i).padStart(8, "0")}`, username: `user${i}`, date_first: t - 3600, date_last: t, count: 1 + (i % 4),
    ip: `203.0.113.${(i % 250) + 1}`, user_agent: "Mozilla/5.0 (mock)", isp: "Mock ISP", country: "CA", region: "ON",
  };
}

/** team.accessLogs: newest first, cursor paging, `{ok:false}` on bad auth. */
export function slackMock(logins: Record<string, unknown>[], token: string) {
  return (req: Request): Response => {
    if (req.headers.get("authorization") !== `Bearer ${token}`) return json({ ok: false, error: "invalid_auth" });
    const url = new URL(req.url);
    if (mockHost(req) !== "slack.com" || url.pathname !== "/api/team.accessLogs") return json({}, 404);
    const limit = Number(url.searchParams.get("limit") ?? "100");
    const off = Number((url.searchParams.get("cursor") ?? "").replace(/^dXNlcj/, "")) || 0;
    const page = logins.slice(off, off + limit);
    const next = off + limit < logins.length ? `dXNlcj${off + limit}` : "";
    return json({ ok: true, logins: page, paging: { count: limit, total: logins.length }, response_metadata: { next_cursor: next } });
  };
}
