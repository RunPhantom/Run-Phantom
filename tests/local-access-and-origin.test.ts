import { describe, expect, test } from "bun:test";
import {
  hostnameOnly,
  isAllowedRemoteAddress,
  isLoopbackRemoteAddress,
  parseAllowedHostsEnv,
  parseAllowedSourceIpsEnv,
} from "../src/local-access";
import {
  createLocalOriginGuard,
  isAllowedRunPhantomOrigin,
  parseAllowedOriginsEnv,
} from "../src/local-origin-guard";

function runOriginGuard(
  headers: Record<string, string | undefined>,
  extraAllowedOrigins: string[] = [],
  daemonPort: number | (() => number | null) = 5947,
  uiPort = 5948,
): { nextCalled: boolean; statusCode: number | null; body: unknown } {
  let nextCalled = false;
  let statusCode: number | null = null;
  let body: unknown;

  const handler = createLocalOriginGuard({ daemonPort, uiPort, extraAllowedOrigins });
  const req = { headers } as any;
  const res = {
    status(code: number) {
      statusCode = code;
      return this;
    },
    json(payload: unknown) {
      body = payload;
      return this;
    },
  } as any;

  handler(req, res, () => {
    nextCalled = true;
  });

  return { nextCalled, statusCode, body };
}

describe("local access helpers", () => {
  test("accepts loopback source addresses and rejects public ones", () => {
    expect(isLoopbackRemoteAddress("127.0.0.1")).toBe(true);
    expect(isLoopbackRemoteAddress("::1")).toBe(true);
    expect(isLoopbackRemoteAddress("::ffff:127.0.0.1")).toBe(true);
    expect(isLoopbackRemoteAddress("203.0.113.22")).toBe(false);
    expect(isLoopbackRemoteAddress(undefined)).toBe(false);
  });

  test("allows non-loopback sources only by exact IP", () => {
    const allowed = parseAllowedSourceIpsEnv("10.0.0.7, 192.168.1.10, fd12::abcd, invalid");
    expect(allowed).toEqual(new Set(["10.0.0.7", "192.168.1.10", "fd12::abcd"]));
    expect(isAllowedRemoteAddress("127.0.0.1", allowed)).toBe(true);
    expect(isAllowedRemoteAddress("::ffff:127.0.0.1", allowed)).toBe(true);
    expect(isAllowedRemoteAddress("10.0.0.7", allowed)).toBe(true);
    expect(isAllowedRemoteAddress("::ffff:10.0.0.7", allowed)).toBe(true);
    expect(isAllowedRemoteAddress("10.0.0.8", allowed)).toBe(false);
    expect(isAllowedRemoteAddress("192.168.1.11", allowed)).toBe(false);
    expect(isAllowedRemoteAddress("8.8.8.8", allowed)).toBe(false);
    expect(isAllowedRemoteAddress(undefined, allowed)).toBe(false);
  });

  test("normalizes host allowlists and preserves IPv6 host parsing", () => {
    expect(parseAllowedHostsEnv(" localhost:5948, http://host.docker.internal:5947/, [::1]:5947 "))
      .toEqual(new Set(["localhost", "host.docker.internal", "::1"]));
    expect(hostnameOnly("localhost:5948")).toBe("localhost");
    expect(hostnameOnly("[::1]:5947")).toBe("::1");
    expect(hostnameOnly("::1")).toBe("::1");
  });
});

describe("local origin guard", () => {
  test("recognizes only configured Run Phantom browser origins", () => {
    expect(isAllowedRunPhantomOrigin("http://localhost:5948", 5947, 5948)).toBe(true);
    expect(isAllowedRunPhantomOrigin("http://127.0.0.1:5947/path", 5947, 5948)).toBe(true);
    expect(isAllowedRunPhantomOrigin("http://[::1]:5947", 5947, 5948)).toBe(true);
    expect(isAllowedRunPhantomOrigin("http://localhost:6000", 5947, 5948)).toBe(false);
    expect(isAllowedRunPhantomOrigin("https://localhost:5948", 5947, 5948)).toBe(false);
    expect(isAllowedRunPhantomOrigin("https://example.com", 5947, 5948)).toBe(false);
    expect(isAllowedRunPhantomOrigin(null, 5947, 5948)).toBe(false);
  });

  test("normalizes extra allowed origins from environment format", () => {
    expect(parseAllowedOriginsEnv(" https://Example.com/app/ , http://localhost:5948/ , file:///tmp/x "))
      .toEqual(new Set(["https://example.com", "http://localhost:5948"]));
  });

  test("allows non-browser callers through unchanged", () => {
    const result = runOriginGuard({});
    expect(result.nextCalled).toBe(true);
    expect(result.statusCode).toBeNull();
  });

  test("allows the daemon and UI origins", () => {
    const result = runOriginGuard({ origin: "http://localhost:5948" });
    expect(result.nextCalled).toBe(true);
    expect(result.statusCode).toBeNull();

    const daemon = runOriginGuard({ origin: "http://127.0.0.1:5947" });
    expect(daemon.nextCalled).toBe(true);
    expect(daemon.statusCode).toBeNull();
  });

  test("blocks loopback origins on arbitrary ports", () => {
    const result = runOriginGuard({ origin: "http://localhost:6000" });
    expect(result.nextCalled).toBe(false);
    expect(result.statusCode).toBe(403);
  });

  test("allows explicit referer paths when only the origin was allowlisted", () => {
    const result = runOriginGuard(
      { referer: "https://runphantom.local/settings/secrets?tab=query" },
      ["https://runphantom.local"],
    );
    expect(result.nextCalled).toBe(true);
    expect(result.statusCode).toBeNull();
  });

  test("blocks non-loopback browser origins that were not allowlisted", () => {
    const result = runOriginGuard({ origin: "https://evil.example" });
    expect(result.nextCalled).toBe(false);
    expect(result.statusCode).toBe(403);
    expect(result.body).toEqual({ error: "origin not allowed" });
  });

  test("uses the current daemon port when it is resolved dynamically", () => {
    let port = 0;
    expect(runOriginGuard({ origin: "http://localhost:61234" }, [], () => port).statusCode).toBe(403);
    port = 61234;
    expect(runOriginGuard({ origin: "http://localhost:61234" }, [], () => port).nextCalled).toBe(true);
  });
});
