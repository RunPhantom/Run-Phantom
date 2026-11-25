import { randomBytes } from "node:crypto";

const DEFAULT_OTLP_ENDPOINT = "http://localhost:5947/v1/traces";

export type AttributeValue = string | number | boolean | string[];

type OtlpValue =
  | { stringValue: string }
  | { intValue: string }
  | { doubleValue: number }
  | { boolValue: boolean }
  | { arrayValue: { values: { stringValue: string }[] } };

interface SpanEvent {
  name: string;
  timeUnixNano: string;
  attributes: Record<string, AttributeValue>;
}

export interface SpanStatus {
  code: 1 | 2;
  message?: string;
}

const hex = (bytes: number) => randomBytes(bytes).toString("hex");
const nanos = (ms: number) => (BigInt(Math.round(ms)) * 1_000_000n).toString();

function otlpValue(value: AttributeValue): OtlpValue {
  if (Array.isArray(value)) return { arrayValue: { values: value.map((item) => ({ stringValue: item })) } };
  if (typeof value === "boolean") return { boolValue: value };
  if (typeof value === "number") return Number.isSafeInteger(value) ? { intValue: String(value) } : { doubleValue: value };
  return { stringValue: value };
}

function otlpAttributes(attributes: Record<string, AttributeValue>) {
  return Object.entries(attributes).map(([key, value]) => ({ key, value: otlpValue(value) }));
}

export function tracesEndpoint(): string {
  return process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT || DEFAULT_OTLP_ENDPOINT;
}

/** The Run Phantom page for a trace, assuming the collector is the Run Phantom daemon. */
export function runUrl(traceId: string): string {
  try {
    return `${new URL(tracesEndpoint()).origin}/runs/${traceId}`;
  } catch {
    return `http://localhost:5947/runs/${traceId}`;
  }
}

export class Span {
  readonly spanId = hex(8);
  readonly startedAtMs = Date.now();
  readonly attributes: Record<string, AttributeValue> = {};
  private endedAtMs: number | undefined;
  private status: SpanStatus | undefined;
  private readonly events: SpanEvent[] = [];

  constructor(
    readonly trace: Trace,
    readonly name: string,
    readonly kind: 1 | 3,
    readonly parentSpanId: string | undefined,
  ) {}

  set(attributes: Record<string, AttributeValue | undefined | null>): this {
    for (const [key, value] of Object.entries(attributes)) {
      if (value !== undefined && value !== null) this.attributes[key] = value;
    }
    return this;
  }

  child(name: string, kind: 1 | 3 = 1): Span {
    return this.trace.startSpan(name, kind, this.spanId);
  }

  recordException(error: Error): void {
    this.events.push({
      name: "exception",
      timeUnixNano: nanos(Date.now()),
      attributes: { "exception.type": error.name, "exception.message": error.message },
    });
  }

  end(status: SpanStatus = { code: 1 }): void {
    if (this.endedAtMs !== undefined) return;
    this.endedAtMs = Date.now();
    this.status = status;
  }

  get ended(): boolean {
    return this.endedAtMs !== undefined;
  }

  toOtlp() {
    return {
      traceId: this.trace.traceId,
      spanId: this.spanId,
      ...(this.parentSpanId ? { parentSpanId: this.parentSpanId } : {}),
      name: this.name,
      kind: this.kind,
      startTimeUnixNano: nanos(this.startedAtMs),
      endTimeUnixNano: nanos(this.endedAtMs ?? Date.now()),
      attributes: otlpAttributes(this.attributes),
      ...(this.events.length
        ? { events: this.events.map((event) => ({ ...event, attributes: otlpAttributes(event.attributes) })) }
        : {}),
      status: this.status ?? { code: 1 },
    };
  }
}

/** Collects every span of one agent run and exports them as a single OTLP/HTTP JSON request. */
export class Trace {
  readonly traceId = hex(16);
  private readonly spans: Span[] = [];

  startSpan(name: string, kind: 1 | 3 = 1, parentSpanId?: string): Span {
    const span = new Span(this, name, kind, parentSpanId);
    this.spans.push(span);
    return span;
  }

  otlpBody(serviceName: string) {
    return {
      resourceSpans: [{
        resource: { attributes: otlpAttributes({ "service.name": serviceName }) },
        scopeSpans: [{
          scope: { name: "runphantom.examples.tool-agent", version: "1.0.0" },
          spans: this.spans.map((span) => span.toOtlp()),
        }],
      }],
    };
  }

  async export(serviceName = "runphantom-tool-agent"): Promise<void> {
    const response = await fetch(tracesEndpoint(), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(this.otlpBody(serviceName)),
    });
    if (!response.ok) throw new Error(`OTLP export to ${tracesEndpoint()} failed with HTTP ${response.status}`);
  }
}
