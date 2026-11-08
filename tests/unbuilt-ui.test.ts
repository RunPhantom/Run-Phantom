import { expect, test } from "bun:test";
import { devUiLocation, devUiOrigin, isPageNavigation, unbuiltUiPage } from "../src/unbuilt-ui";

test("only a loopback http development UI origin is trusted", () => {
  expect(devUiOrigin("http://localhost:5948")).toBe("http://localhost:5948");
  expect(devUiOrigin("http://127.0.0.1:6222/ignored/path")).toBe("http://127.0.0.1:6222");
  expect(devUiOrigin("http://[::1]:5948")).toBe("http://[::1]:5948");
  for (const raw of [undefined, "", "not a url", "https://localhost:5948", "http://example.com:5948", "http://user:pass@localhost:5948", "javascript:alert(1)"]) {
    expect(devUiOrigin(raw)).toBeNull();
  }
});

test("example run links keep their path and query on the development UI", () => {
  expect(devUiLocation("http://localhost:5948", "/runs/9ff21c84fe67bd1f1db4c91877451b0c")).toBe("http://localhost:5948/runs/9ff21c84fe67bd1f1db4c91877451b0c");
  expect(devUiLocation("http://localhost:5948", "/runs/abc/span/def?tab=tree")).toBe("http://localhost:5948/runs/abc/span/def?tab=tree");
  expect(devUiLocation("http://localhost:5948", "//evil.example/phish")).toBe("http://localhost:5948/");
});

test("only browser page loads are redirected; API and ingest callers keep JSON", () => {
  const page = { method: "GET", path: "/runs/abc", originalUrl: "/runs/abc", accept: "text/html,application/xhtml+xml" };
  expect(isPageNavigation(page)).toBe(true);
  expect(isPageNavigation({ ...page, method: "HEAD" })).toBe(true);
  expect(isPageNavigation({ ...page, method: "POST" })).toBe(false);
  expect(isPageNavigation({ ...page, accept: "application/json" })).toBe(false);
  expect(isPageNavigation({ ...page, accept: undefined })).toBe(false);
  expect(isPageNavigation({ ...page, path: "/api/runs", originalUrl: "/api/runs" })).toBe(false);
});

test("without a development UI the page explains how to reach the UI", () => {
  const html = unbuiltUiPage("6222");
  expect(html).toContain("http://localhost:6222");
  expect(html).toContain("bun run build:ui");
  expect(unbuiltUiPage("<script>")).not.toContain("<script>");
});
