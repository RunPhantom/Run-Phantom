import { describe, expect, test } from "bun:test";
import { BROWSER_HTTP_LIMITS as LIMIT } from "../src/verification/browser-contract";
import { browserCorsUnsafeByte, browserSafelistedValue, browserForeignHeaderValues, browserRawHeaderBudget,
  createBrowserTransport, BrowserTransportRefusal, browserControlledCookies, browserControlledSetCookie, type BrowserTransportRoute, type BrowserHttpRefusal } from "../src/verification/browser-transport";

const refused = (task: () => void, code = "cross-origin-headers") => expect(task).toThrow(expect.objectContaining({ code }));

describe("bounded browser header admission", () => {
  test("all byte values and language alphabets follow the conservative Fetch subset", () => {
    const punctuation = [34, 40, 41, 58, 60, 62, 63, 64, 91, 92, 93, 123, 125, 127];
    for (let byte = 0; byte < 256; byte++) {
      const unsafe = byte <= 8 || byte >= 10 && byte <= 31 || punctuation.includes(byte);
      const value = String.fromCharCode(byte), language = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz *,-.;=".includes(value);
      expect(browserCorsUnsafeByte(byte)).toBe(unsafe);
      expect(browserSafelistedValue("accept", value)).toBe(byte < 128 && !unsafe);
      if (unsafe) expect(browserSafelistedValue("content-type", `text/plain;x=${value}`)).toBe(false);
      expect(browserSafelistedValue("accept-language", value)).toBe(language);
      expect(browserSafelistedValue("content-language", value)).toBe(language);
    }
  });
  test("whole values, raw aggregate, repeated fields and MIME quotes cannot bypass bounds", () => {
    for (const name of ["accept", "accept-language", "content-language"]) for (const length of [127, 128, 129]) expect(browserSafelistedValue(name, "a".repeat(length))).toBe(length <= 128);
    for (const length of [127, 128, 129]) expect(browserSafelistedValue("content-type", "text/plain;x=" + "a".repeat(length - 13))).toBe(length <= 128);
    for (const value of ["text/plain", "TEXT/PLAIN", "\ttext/plain \t", "text/plain; charset=utf-8", "multipart/form-data; boundary=fixture-123", "application/x-www-form-urlencoded", "text/plain; X=abc; y=def"]) expect(browserSafelistedValue("content-type", value)).toBe(true);
    for (const value of ["", 'text/plain; charset="utf-8"', "text/plain; charset=utf\\8", "text/plain;", "text/plain;;x=y", "text/plain;x=", "text/plain;x=y=z", "text/plain;x=a b", "text/plain; x =a", "text/plain;x=a;X=b", "text/plain, application/json", "text /plain", "text/ plain", "text/plain/json", "text/plain\u00a0", "text/plain;\u00a0x=a", "text/plain\n", "text/plain\r", "text/plain;x=\u0100"]) expect(browserSafelistedValue("content-type", value)).toBe(false);
    const exact = Array.from({ length: 8 }, () => ({ name: "Accept", value: "a".repeat(128) }));
    browserForeignHeaderValues(exact, {});
    refused(() => browserForeignHeaderValues([...exact, { name: "accept", value: "a" }], {}));
    browserForeignHeaderValues([{ name: "Accept", value: "a".repeat(63) }, { name: "Accept", value: "b".repeat(63) }], { accept: "a".repeat(63) + ", " + "b".repeat(63) });
    refused(() => browserForeignHeaderValues([{ name: "Accept", value: "a".repeat(64) }, { name: "Accept", value: "b".repeat(64) }], { accept: "a".repeat(64) + ", " + "b".repeat(64) }));
    refused(() => browserForeignHeaderValues([{ name: "content-type", value: "text/plain" }], { "content-type": 'text/plain; charset="utf-8"' }));
    refused(() => browserForeignHeaderValues([{ name: "content-type", value: 'text/plain; charset="utf-8"' }], { "content-type": "text/plain" }));
    expect(browserSafelistedValue("range", "bytes=0-1")).toBe(false);
    expect(browserSafelistedValue("accept", "é".repeat(64))).toBe(false);
    browserRawHeaderBudget(["x", "é".repeat((LIMIT.headers - 2) / 2) + "a"], "request-headers");
    refused(() => browserRawHeaderBudget(["x", "é".repeat(LIMIT.headers / 2)], "request-headers"), "request-headers");
    browserRawHeaderBudget(Array.from({ length: 200 }, () => "a"), "request-headers");
    refused(() => browserRawHeaderBudget(Array.from({ length: 202 }, () => "a"), "request-headers"), "request-headers");
    expect(new BrowserTransportRefusal("request-headers").message).not.toContain("x");
  });
  test("controlled cookie admission requires exact native host/path/secure and qualified attributes", () => {
    const url = new URL("http://127.0.0.1/account/pay"), cookie = { name: "qualified", value: "opaque", domain: "127.0.0.1", path: "/account", httpOnly: true, sameSite: "Strict", secure: false };
    browserControlledCookies([cookie], "qualified=opaque", url);
    for (const change of [{ domain: ".127.0.0.1" }, { path: "/acc" }, { path: "/other" }, { httpOnly: false }, { sameSite: "Lax" }, { secure: true }]) refused(() => browserControlledCookies([{ ...cookie, ...change }], "qualified=opaque", url), "cookie-profile-unavailable");
    for (const actual of [undefined, "qualified=wrong", "unrelated=opaque", "qualified=opaque; qualified=opaque"]) refused(() => browserControlledCookies([cookie], actual, url), "cookie-profile-unavailable");
    browserControlledSetCookie(["Set-Cookie", "qualified=opaque; Path=/; HttpOnly; SameSite=Strict"], url);
    for (const value of ["qualified=opaque; Path=/; SameSite=Strict", "qualified=opaque; Path=/; HttpOnly; SameSite=Lax", "qualified=opaque; Path=/other; HttpOnly; SameSite=Strict", "qualified=opaque; Path=/; HttpOnly; SameSite=Strict; Domain=127.0.0.1", "qualified=opaque; Path=/; HttpOnly; SameSite=Strict; Secure", "qualified=opaque; Path=/; HttpOnly; SameSite=Strict; Expires=Wed, 01 Jan 2030 00:00:00 GMT", "qualified=opaque; Path=/; HttpOnly; SameSite=Strict,other=opaque"]) refused(() => browserControlledSetCookie(["set-cookie", value], url), "set-cookie-profile-unavailable");
    refused(() => browserControlledSetCookie(["set-cookie", "qualified=opaque; Path=/; HttpOnly; SameSite=Strict", "set-cookie", "other=opaque; Path=/; HttpOnly; SameSite=Strict"], url), "set-cookie-profile-unavailable");
  });
});

function route(url: string, header: Record<string, string> = {}, overrides: Partial<BrowserTransportRoute["request"] extends () => infer R ? R : never> = {}) {
  let aborted = 0, fulfilled = 0, reads = 0;
  const request = { url: () => url, method: () => "GET", isNavigationRequest: () => false,
    headersArray: async () => { reads++; return Object.entries(header).map(([name, value]) => ({ name, value })); },
    allHeaders: async () => header, postDataBuffer: () => null, ...overrides };
  const handle: BrowserTransportRoute = { request: () => request, abort: async () => { aborted++; }, fulfill: async () => { fulfilled++; } };
  return { handle, proof: () => ({ aborted, fulfilled, reads }) };
}

describe("bounded browser transport lifecycle", () => {
  test("unsafe values, unqualified profiles and exhausted admission open zero actual requests", async () => {
    let requests = 0;
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { requests++; return new Response("fact"); } });
    const foreign = `http://127.0.0.1:${server.port}`, refusals: BrowserHttpRefusal[] = [];
    const transport = createBrowserTransport({ origin: "http://127.0.0.1:1", assets: [foreign], controlOrigins: [], engine: "chromium", ownership: "owned", foreignQualified: true, cookies: async () => [], authority: () => ({ current: () => true }), onRefusal: reason => refusals.push(reason) });
    try {
      for (const headers of [{ "content-type": 'text/plain; charset="utf-8"' }, { accept: "text/plain\\evil" }, { priority: "u=1" }, { "upgrade-insecure-requests": "1" }]) {
        const attempted = route(foreign, headers); await transport.handler(attempted.handle); expect(attempted.proof()).toEqual({ aborted: 1, fulfilled: 0, reads: 1 });
      }
      expect(requests).toBe(0); expect(refusals).toEqual(Array(4).fill("cross-origin-headers"));
      const safe = route(foreign, { accept: "text/plain" }); await transport.handler(safe.handle); expect(safe.proof().fulfilled).toBe(1); expect(requests).toBe(1);
      for (let attempt = 5; attempt < 1105; attempt++) await transport.handler(route("http://127.0.0.1:2").handle);
      const proof = transport.proof(); expect(proof.attempts).toBe(1000); expect(proof.beyondLimit).toBe(105); expect(proof.records).toHaveLength(100); expect(proof.closed).toBe(true); expect(requests).toBe(1);
      expect(proof.records.every(record => Object.keys(record).sort().join(",") === "reason,result")).toBe(true);
      const unqualified = createBrowserTransport({ origin: "http://127.0.0.1:1", assets: [foreign], controlOrigins: [], engine: "chromium", ownership: "owned", cookies: async () => [], authority: () => ({ current: () => true }), onRefusal: () => {} });
      await unqualified.handler(route(foreign).handle); expect(unqualified.proof().counts["foreign-profile-unavailable"]).toBe(1); expect(requests).toBe(1);
    } finally { transport.close(); await server.stop(true); }
  });
  test("close and generation fences prevent late header and cookie results from allocating sockets", async () => {
    let requests = 0; const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { requests++; return new Response("fact"); } });
    const origin = `http://127.0.0.1:${server.port}`;
    try {
      for (const stage of ["headers", "cookies"]) {
        let release!: () => void, entered!: () => void, current = true;
        const held = new Promise<void>(resolve => { release = resolve; }), marker = new Promise<void>(resolve => { entered = resolve; });
        const transport = createBrowserTransport({ origin, assets: [], controlOrigins: [], engine: "webkit", ownership: "owned", cookies: async () => { if (stage === "cookies") { entered(); await held; } return []; }, authority: () => ({ current: () => current }), onRefusal: () => {} });
        const attempted = route(origin, {}, stage === "headers" ? { headersArray: async () => { entered(); await held; return []; } } : {});
        const pending = transport.handler(attempted.handle); await marker; current = false; transport.fence(); transport.close(); release(); await pending;
        expect(requests).toBe(0); expect(attempted.proof().fulfilled).toBe(0); expect(transport.proof()).toMatchObject({ active: 0, pending: 0, retainedBodyChunks: 0, openResponseStreams: 0 });
      }
    } finally { await server.stop(true); }
  });
});
