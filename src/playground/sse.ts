export interface SseEvent {
  event: string | null;
  data: string;
}

export class ResponseLimitError extends Error {
  constructor() { super("Provider response exceeded its limit."); this.name = "ResponseLimitError"; }
}

/** Parses a text/event-stream body per the WHATWG event-stream rules, refusing to buffer more than maxBytes in total. */
export async function* readSse(body: ReadableStream<Uint8Array>, maxBytes: number): AsyncGenerator<SseEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "", total = 0, event: string | null = null, data: string[] = [];
  const flushLine = function* (line: string): Generator<SseEvent> {
    if (line === "") {
      if (data.length) yield { event, data: data.join("\n") };
      event = null; data = [];
      return;
    }
    if (line.startsWith(":")) return;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "data") data.push(value);
    else if (field === "event") event = value;
  };
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > maxBytes) throw new ResponseLimitError();
      buffer += decoder.decode(chunk.value, { stream: true });
      let newline: number;
      while ((newline = buffer.search(/\r\n|\r|\n/)) !== -1) {
        const line = buffer.slice(0, newline);
        const width = buffer[newline] === "\r" && buffer[newline + 1] === "\n" ? 2 : 1;
        // A lone CR at the end of a chunk may be the first half of CRLF.
        if (buffer[newline] === "\r" && newline + 1 === buffer.length) break;
        buffer = buffer.slice(newline + width);
        yield* flushLine(line);
      }
    }
    buffer += decoder.decode();
    for (const line of buffer.split(/\r\n|\r|\n/)) yield* flushLine(line);
    yield* flushLine("");
  } finally {
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** Reads a whole (error) body as text, keeping at most maxBytes. */
export async function readBoundedText(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      const room = maxBytes - size;
      if (room <= 0) break;
      const piece = chunk.value.byteLength > room ? chunk.value.subarray(0, room) : chunk.value;
      parts.push(piece);
      size += piece.byteLength;
    }
  } finally {
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) { bytes.set(part, offset); offset += part.byteLength; }
  return new TextDecoder("utf-8").decode(bytes);
}
