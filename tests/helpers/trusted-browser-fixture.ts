import { TRUSTED_BROWSER_FIXTURE_HTML } from "./trusted-browser-fixture-html";
export { TRUSTED_BROWSER_FIXTURE_HTML } from "./trusted-browser-fixture-html";

export function trustedBrowserFixture() {
  const events: Array<{ type: string; trusted: boolean; value?: string }> = [];
  let duplicate = 0;
  const html = TRUSTED_BROWSER_FIXTURE_HTML;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/events") { const event: unknown = await request.json(); if (event && typeof event === "object") events.push(event as typeof events[number]); return new Response("recorded"); }
    if (url.pathname === "/accepted") return new Response("accepted", { status: 202 });
    if (url.pathname === "/duplicate") { const number = ++duplicate; await new Promise(resolve => setTimeout(resolve, number === 1 ? 200 : 10)); return new Response("fact", { status: number === 1 ? 201 : 202 }); }
    if (url.pathname === "/delayed-body") return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode("started")); setTimeout(() => { controller.enqueue(new TextEncoder().encode("completed")); controller.close(); }, 900); } }));
    return new Response(html, { headers: { "content-type": "text/html" } });
  } });
  return { origin: `http://127.0.0.1:${server.port}`, events, close: () => server.stop(true) };
}
