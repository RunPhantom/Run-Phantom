import { randomBytes, randomUUID } from "node:crypto";

const DEFAULT_OTLP_ENDPOINT = "http://localhost:5947/v1/traces";

type AttributeValue = string | number | boolean;

interface CompletedSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: Record<string, AttributeValue>;
  status?: { code: number; message?: string };
}

export interface LlmSpanInput {
  name: string;
  provider: string;
  model: string;
  input: unknown;
  output: unknown;
  startedAtMs: number;
  endedAtMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  error?: string;
}

function id(bytes: number): string {
  return randomBytes(bytes).toString("hex");
}

function nano(ms: number): string {
  return (BigInt(ms) * 1_000_000n).toString();
}

function attribute(key: string, value: AttributeValue) {
  if (typeof value === "boolean") return { key, value: { boolValue: value } };
  if (typeof value === "number") return { key, value: { intValue: String(value) } };
  return { key, value: { stringValue: value } };
}

function endpoint(): string {
  return process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT || DEFAULT_OTLP_ENDPOINT;
}

function runOrigin(): string {
  try {
    return new URL(endpoint()).origin;
  } catch {
    return "http://localhost:5947";
  }
}

export class ExampleTrace {
  readonly traceId = id(16);
  readonly eventId = randomUUID();
  private readonly rootSpanId = id(8);
  private readonly startedAtMs = Date.now();
  private readonly spans: CompletedSpan[] = [];

  constructor(
    private readonly name: string,
    private readonly input: unknown,
    private readonly conversationId?: string,
  ) {}

  addLlm(input: LlmSpanInput): void {
    const attributes: Record<string, AttributeValue> = {
      "runphantom.span.kind": "llm_call",
      "gen_ai.operation.name": "chat",
      "gen_ai.provider.name": input.provider,
      "gen_ai.request.model": input.model,
      "gen_ai.input.messages": JSON.stringify(input.input),
      "gen_ai.output.messages": JSON.stringify(input.output),
    };
    if (input.inputTokens !== undefined) attributes["gen_ai.usage.input_tokens"] = input.inputTokens;
    if (input.outputTokens !== undefined) attributes["gen_ai.usage.output_tokens"] = input.outputTokens;

    this.spans.push({
      traceId: this.traceId,
      spanId: id(8),
      parentSpanId: this.rootSpanId,
      name: input.name,
      startTimeUnixNano: nano(input.startedAtMs),
      endTimeUnixNano: nano(input.endedAtMs ?? Date.now()),
      attributes,
      status: input.error ? { code: 2, message: input.error } : { code: 1 },
    });
  }

  async finish(output: unknown, error?: string): Promise<void> {
    const attributes: Record<string, AttributeValue> = {
      "runphantom.span.kind": "agent_root",
      "runphantom.event.id": this.eventId,
      "runphantom.event.name": this.name,
      "runphantom.input": JSON.stringify(this.input),
      "runphantom.output": JSON.stringify(output),
    };
    if (this.conversationId) attributes["runphantom.conversation.id"] = this.conversationId;

    const root: CompletedSpan = {
      traceId: this.traceId,
      spanId: this.rootSpanId,
      name: this.name,
      startTimeUnixNano: nano(this.startedAtMs),
      endTimeUnixNano: nano(Date.now()),
      attributes,
      status: error ? { code: 2, message: error } : { code: 1 },
    };

    const body = {
      resourceSpans: [{
        resource: { attributes: [attribute("service.name", "runphantom-examples")] },
        scopeSpans: [{
          scope: { name: "runphantom.examples", version: "1.0.0" },
          spans: [root, ...this.spans].map((span) => ({
            ...span,
            attributes: Object.entries(span.attributes).map(([key, value]) => attribute(key, value)),
          })),
        }],
      }],
    };

    const response = await fetch(endpoint(), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`OTLP export failed (${response.status})`);
  }

  runUrl(): string {
    return `${runOrigin()}/runs/${this.traceId}`;
  }
}

export function page(title: string, description: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title}</title>
  <style>
    :root {
      color-scheme: light;
      font-family: "Avenir Next", "Segoe UI", ui-sans-serif, system-ui, sans-serif;
      --canvas: #F8F4EE;
      --canvas-bright: #FFFBF6;
      --surface: #FFFBF6;
      --surface-raised: #F2EADF;
      --ink: #302730;
      --muted: #6C616C;
      --border: #9C8870;
      --accent: #B83C24;
      --mark-accent: #C7462D;
      --accent-strong: #9F301D;
      --accent-ink: #FFFBF6;
      --link: #275EA8;
      --focus: #9F301D;
    }

    * { box-sizing: border-box; }

    body {
      margin: 0;
      min-height: 100svh;
      display: grid;
      place-items: center;
      padding: 24px;
      background: var(--canvas);
      color: var(--ink);
    }

    main {
      width: min(760px, 100%);
      padding: clamp(24px, 4vw, 40px);
      border: 1px solid var(--border);
      border-radius: 28px;
      background: var(--surface);
      box-shadow: 0 24px 60px rgba(48, 39, 48, 0.14);
    }

    .brand {
      display: flex;
      gap: 16px;
      align-items: flex-start;
    }

    .brand-mark {
      flex: 0 0 auto;
      width: 52px;
      height: 52px;
      display: block;
      color: var(--ink);
    }

    .eyebrow {
      margin: 2px 0 6px;
      color: var(--muted);
      font: 600 0.74rem/1.3 "SFMono-Regular", Consolas, "Liberation Mono", monospace;
      letter-spacing: 0.16em;
      text-transform: uppercase;
    }

    h1 {
      margin: 0;
      font-family: "Avenir Next Condensed", "Arial Narrow", "Segoe UI Variable Display", sans-serif;
      letter-spacing: -0.04em;
      font-size: clamp(2rem, 5vw, 3rem);
      line-height: 1.03;
    }

    .tagline {
      margin: 16px 0 8px;
      color: var(--accent);
      font-size: 1rem;
      font-weight: 700;
    }

    p {
      margin: 0;
      color: var(--muted);
      line-height: 1.6;
    }

    form {
      display: grid;
      gap: 14px;
      margin-top: 28px;
    }

    label {
      font-size: 0.92rem;
      font-weight: 700;
      color: var(--ink);
    }

    textarea,
    button {
      border-radius: 18px;
      border: 1px solid var(--border);
      padding: 14px 16px;
      font: inherit;
    }

    textarea {
      min-height: 136px;
      resize: vertical;
      background: var(--surface-raised);
      color: var(--ink);
      box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.7);
    }

    textarea::placeholder { color: var(--muted); }

    textarea:focus-visible,
    button:focus-visible,
    a:focus-visible {
      outline: 3px solid var(--focus);
      outline-offset: 3px;
    }

    .actions {
      display: grid;
      gap: 12px;
      align-items: center;
    }

    .hint {
      font-size: 0.95rem;
    }

    button {
      width: auto;
      min-width: 200px;
      justify-self: start;
      background: var(--accent);
      color: var(--accent-ink);
      font-weight: 750;
      cursor: pointer;
      box-shadow: 0 12px 24px rgba(184, 60, 36, 0.2);
      transition: transform 160ms ease, background-color 160ms ease, box-shadow 160ms ease;
    }

    button:hover:not(:disabled) {
      transform: translateY(-1px);
      background: var(--accent-strong);
      box-shadow: 0 16px 28px rgba(159, 48, 29, 0.24);
    }

    button:disabled {
      opacity: 0.6;
      cursor: wait;
      transform: none;
      box-shadow: none;
    }

    #result {
      min-width: 0;
      min-height: 52px;
      margin-top: 22px;
      padding-top: 18px;
      border-top: 1px solid var(--border);
      color: var(--ink);
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      word-break: break-word;
    }

    a {
      color: var(--link);
      font-weight: 700;
      text-underline-offset: 0.16em;
    }

    @media (min-width: 640px) {
      .actions {
        grid-template-columns: 1fr auto;
        gap: 16px;
        align-items: end;
      }
    }

    @media (max-width: 640px) {
      body { padding: 16px; }
      main { padding: 22px; border-radius: 22px; }
      .brand { gap: 12px; }
      .brand-mark { width: 46px; height: 46px; }
      button { width: 100%; min-width: 0; }
    }
    @media (prefers-reduced-motion: reduce) {
      *, *::before, *::after { animation: none !important; scroll-behavior: auto !important; transition: none !important; }
    }
  </style>
</head>
<body><main>
<header>
  <div class="brand">
    <svg
      class="brand-mark"
      viewBox="0 0 64 64"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      focusable="false"
    >
      <rect width="64" height="64" rx="16" fill="var(--surface-raised)"></rect>
      <path
        d="M12 26V12H26M38 52H52V38"
        stroke="currentColor"
        stroke-width="5"
        stroke-linecap="round"
        stroke-linejoin="round"
      ></path>
      <path
        d="M12 42C20 42 20 22 30 22C40 22 39 42 52 42"
        stroke="currentColor"
        stroke-width="4.5"
        stroke-linecap="round"
      ></path>
      <circle cx="30" cy="22" r="5" fill="var(--mark-accent)"></circle>
    </svg>
    <div>
      <p class="eyebrow">Run Phantom example</p>
      <h1>${title}</h1>
    </div>
  </div>
  <p class="tagline">See the run. Find the reason.</p>
  <p>${description}</p>
</header>
<form id="chat">
  <label for="message">Prompt</label>
  <textarea id="message" name="message" required placeholder="Ask the model something."></textarea>
  <div class="actions">
    <p class="hint">This sends one provider-direct request and exports the trace to your local Run Phantom daemon.</p>
    <button>Send and trace</button>
  </div>
</form>
<p id="result" role="status" aria-live="polite"></p></main>
<script>
const form = document.querySelector('#chat');
const result = document.querySelector('#result');
form.addEventListener('submit', async (event) => {
  event.preventDefault(); const button = form.querySelector('button'); button.disabled = true; result.textContent = 'Running...';
  try {
    const response = await fetch('/api/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: new FormData(form).get('message') }) });
    const body = await response.json(); if (!response.ok) throw new Error(body.error || 'Request failed');
    result.replaceChildren(document.createTextNode(body.text + '\\n'), Object.assign(document.createElement('a'), { href: body.runUrl, textContent: 'Open in Run Phantom' }));
  } catch (error) { result.textContent = error.message; } finally { button.disabled = false; }
});
</script></body></html>`;
}
