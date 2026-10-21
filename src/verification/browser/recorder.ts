import { parseRecordingBatch, RecordingInputError, type RecordingBatch } from "../recording-types";

export type RecorderInstall = { key: string; secret: string; publish?: boolean };
export type ProducerPull = {
  batch: string | null; loss: boolean; dropped: number | null; stopped: boolean;
  reason: "none" | "queue" | "capacity" | "timeout" | "unavailable" | "node-cap" | "visit-cap";
  clock: { anchorEpochMs: number; nowEpochMs: number; monotonicElapsedMs: number };
};
export type MaskedProducer = {
  pull(secret: string, sequence: number, document: number, ordinalBase: number): string;
  stop(secret: string): void;
  discard(secret: string): void;
};

export function parseProducerPull(raw: string): ProducerPull {
  const invalid = () => { throw new RecordingInputError("Invalid native recorder envelope"); };
  if (typeof raw !== "string" || raw.length > 102_400 || new TextEncoder().encode(raw).byteLength > 102_400) return invalid();
  let value: ProducerPull;
  try { value = JSON.parse(raw) as ProducerPull; } catch { return invalid(); }
  if (!value || typeof value !== "object" || Array.isArray(value) || JSON.stringify(value) !== raw || Object.keys(value).sort().join(",") !== "batch,clock,dropped,loss,reason,stopped") return invalid();
  if (typeof value.loss !== "boolean" || typeof value.stopped !== "boolean" || !["none", "queue", "capacity", "timeout", "unavailable", "node-cap", "visit-cap"].includes(value.reason)) return invalid();
  if (value.dropped !== null && (!Number.isSafeInteger(value.dropped) || value.dropped < 0)) return invalid();
  if (value.batch !== null) { if (typeof value.batch !== "string") return invalid(); const batch = parseRecordingBatch(value.batch); if (batch.loss !== value.loss || batch.dropped !== value.dropped) return invalid(); }
  const clock = value.clock;
  if (!clock || typeof clock !== "object" || Array.isArray(clock) || Object.keys(clock).sort().join(",") !== "anchorEpochMs,monotonicElapsedMs,nowEpochMs" || !Number.isSafeInteger(clock.anchorEpochMs) || !Number.isSafeInteger(clock.nowEpochMs) || clock.anchorEpochMs < 0 || clock.nowEpochMs < clock.anchorEpochMs || clock.nowEpochMs > 8_640_000_000_000_000 || !Number.isFinite(clock.monotonicElapsedMs) || clock.monotonicElapsedMs < 0 || clock.monotonicElapsedMs > 8_640_000_000_000_000) return invalid();
  return value;
}

/** Serialize this self-contained function into a pre-author native realm, never a late page world. */
export function installMaskedRecorder(config: RecorderInstall): MaskedProducer {
  // Capture functions AND receiver handles. No page callback or callable host authority is exposed.
  /* eslint-disable @typescript-eslint/unbound-method -- Captured receiver handles are used with captured Reflect.apply below. */
  const apply = Reflect.apply, define = Object.defineProperty, descriptor = Object.getOwnPropertyDescriptor;
  const freeze = Object.freeze, setPrototype = Object.setPrototypeOf, stringify = JSON.stringify;
  const push = Array.prototype.push, shift = Array.prototype.shift;
  const floor = Math.floor, min = Math.min, max = Math.max, finite = Number.isFinite, safe = Number.isSafeInteger;
  const dateNow = Date.now, perf = performance, perfNow = performance.now;
  const NativeError = Error;
  const windowHandle = window, doc = document;
  const schedule = window.setTimeout, unschedule = window.clearTimeout;
  const listen = EventTarget.prototype.addEventListener, unlisten = EventTarget.prototype.removeEventListener;
  const documentElement = descriptor(Document.prototype, "documentElement")?.get;
  const nodeType = descriptor(Node.prototype, "nodeType")?.get, firstChild = descriptor(Node.prototype, "firstChild")?.get;
  const elementRect = Element.prototype.getBoundingClientRect, makeWalker = Document.prototype.createTreeWalker, walkNext = TreeWalker.prototype.nextNode;
  const rectX = descriptor(DOMRectReadOnly.prototype, "x")?.get, rectY = descriptor(DOMRectReadOnly.prototype, "y")?.get;
  const rectW = descriptor(DOMRectReadOnly.prototype, "width")?.get, rectH = descriptor(DOMRectReadOnly.prototype, "height")?.get;
  const width = descriptor(windowHandle, "innerWidth")?.get, height = descriptor(windowHandle, "innerHeight")?.get;
  const computed = window.getComputedStyle, property = CSSStyleDeclaration.prototype.getPropertyValue;
  const eventTarget = descriptor(Event.prototype, "target")?.get;
  const clientX = descriptor(MouseEvent.prototype, "clientX")?.get, clientY = descriptor(MouseEvent.prototype, "clientY")?.get;
  const protoContains = Object.prototype.isPrototypeOf;
  const inputProto = HTMLInputElement.prototype, textareaProto = HTMLTextAreaElement.prototype;
  const imageProto = HTMLImageElement.prototype, canvasProto = HTMLCanvasElement.prototype, videoProto = HTMLVideoElement.prototype, frameProto = HTMLIFrameElement.prototype;
  const weak = new WeakMap<object, number>(), weakGet = WeakMap.prototype.get, weakSet = WeakMap.prototype.set;
  const regexpExec = RegExp.prototype.exec;
  /* eslint-enable @typescript-eslint/unbound-method */
  const colorPattern = /^rgba?\(([0-9]{1,3}), ([0-9]{1,3}), ([0-9]{1,3})(?:, ([0-9.]{1,8}))?\)$/;
  const number = Number;
  const key = config.key, secret = config.secret;
  if (!/^[a-f0-9]{64}$/.test(secret) || !/^__rp_[a-f0-9]{32}$/.test(key) || (config.publish !== undefined && typeof config.publish !== "boolean")) throw new NativeError("Invalid host recorder identity");
  if (!documentElement || !nodeType || !firstChild || !rectX || !rectY || !rectW || !rectH || !width || !height || !eventTarget || !clientX || !clientY) throw new NativeError("Native recorder intrinsics unavailable");
  const originEpoch = apply(dateNow, Date, []) as number, originPerf = apply(perfNow, perf, []) as number;
  const epochLimit = 8_640_000_000_000_000;
  const listeners = [] as { type: string; fn: (event: Event) => void }[];
  setPrototype(listeners, null);
  const queue = [] as RecordingBatch["events"][]; setPrototype(queue, null);
  let pending = [] as RecordingBatch["events"]; setPrototype(pending, null);
  let bytes = 0, nextId = 0, ordinal = 0, dropped: number | null = 0, loss = false;
  let stopped = false, reason: ProducerPull["reason"] = "none", timer = 0;
  let observedRoot: Element | null = null;
  function plain<T extends object>(value: T): T { setPrototype(value, null); return value; }
  function tuple<T extends number[]>(value: T): T { setPrototype(value, null); return value; }
  function add<T>(items: T[], item: T): void { apply(push, items, [item]); }
  function now(): number { return min(epochLimit, max(0, floor(originEpoch + max(0, (apply(perfNow, perf, []) as number) - originPerf)))); }
  function lose(why: ProducerPull["reason"]): void {
    loss = true; reason = why;
    if (dropped !== null) dropped = dropped >= 9_007_199_254_740_991 ? null : dropped + 1;
  }
  function root(): Element | null { return apply(documentElement!, doc, []) as Element | null; }
  function end(): void {
    if (stopped) return;
    stopped = true;
    apply(unschedule, windowHandle, [timer]);
    for (let i = 0; i < listeners.length; i++) apply(unlisten, doc, [listeners[i].type, listeners[i].fn, true]);
  }
  function flush(): void {
    if (!pending.length) return;
    if (queue.length >= 4) { lose("queue"); return; }
    add(queue, pending); pending = [] as RecordingBatch["events"]; setPrototype(pending, null); bytes = 0;
  }
  function emit(event: RecordingBatch["events"][number]): void {
    if (stopped) return;
    if (ordinal >= 8192) { lose("capacity"); end(); return; }
    event.ordinal = ++ordinal;
    const encoded = stringify(event);
    // The closed shape is ASCII only, so code units are exact UTF-8 bytes.
    if (encoded.length + 256 > 49152) { lose("capacity"); return; }
    if (pending.length >= 64 || bytes + encoded.length + 256 > 49152) flush();
    if (queue.length >= 4) { lose("queue"); return; }
    add(pending, event); bytes += encoded.length + 1;
  }
  function id(target: object): number | null {
    const existing = apply(weakGet, weak, [target]) as number | undefined;
    if (existing !== undefined) return existing;
    if (nextId >= 2000) { loss = true; dropped = null; reason = "node-cap"; return null; }
    const assigned = ++nextId; apply(weakSet, weak, [target, assigned]); return assigned;
  }
  function contains(proto: object, value: object): boolean { return apply(protoContains, proto, [value]) as boolean; }
  function kind(element: Element): 0 | 1 | 2 | 3 | 4 {
    if (contains(inputProto, element) || contains(textareaProto, element)) return 2;
    if (contains(frameProto, element)) { loss = true; dropped = null; return 4; }
    if (contains(imageProto, element) || contains(canvasProto, element) || contains(videoProto, element)) { loss = true; dropped = null; return 3; }
    const child = apply(firstChild!, element, []) as Node | null;
    return child && apply(nodeType!, child, []) === 3 ? 1 : 0;
  }
  function paint(element: Element): [number, number, number, number] {
    const style = apply(computed, windowHandle, [element]) as CSSStyleDeclaration;
    const color = apply(property, style, ["background-color"]) as string;
    if (color.length > 128) return tuple([225, 230, 240, 255]);
    const match = apply(regexpExec, colorPattern, [color]) as RegExpExecArray | null;
    if (!match) { loss = true; dropped = null; return tuple([225, 230, 240, 255]); }
    return tuple([min(255, number(match[1])), min(255, number(match[2])), min(255, number(match[3])), match[4] === undefined ? 255 : min(255, max(0, floor(number(match[4]) * 255)))]);
  }
  function frame(): void {
    if (stopped) return;
    if (now() - originEpoch >= 60_000) { reason = "timeout"; end(); return; }
    // Queue pressure is checked before DOM traversal and layout/string allocations.
    if (queue.length >= 4) { lose("queue"); return; }
    const documentRoot = root();
    if (!documentRoot) { if (observedRoot) { lose("unavailable"); dropped = null; end(); } return; }
    if (observedRoot && documentRoot !== observedRoot) { lose("unavailable"); dropped = null; end(); return; }
    observedRoot = documentRoot;
    const viewportWidth = apply(width!, windowHandle, []) as number, viewportHeight = apply(height!, windowHandle, []) as number;
    if (!finite(viewportWidth) || !finite(viewportHeight)) { lose("unavailable"); end(); return; }
    const vw = min(1920, max(1, floor(viewportWidth))), vh = min(1080, max(1, floor(viewportHeight)));
    const walker = apply(makeWalker, doc, [documentRoot, 1]) as TreeWalker;
    const nodes = [] as Extract<RecordingBatch["events"][number], { kind: 0 }>["nodes"]; setPrototype(nodes, null);
    let current: Element | null = documentRoot, visited = 0, clipped = false;
    while (current && visited < 2000) {
      visited++;
      const rect = apply(elementRect, current, []) as DOMRect;
      const x = apply(rectX!, rect, []) as number, y = apply(rectY!, rect, []) as number, w = apply(rectW!, rect, []) as number, h = apply(rectH!, rect, []) as number;
      if (finite(x) && finite(y) && finite(w) && finite(h) && w > 0 && h > 0 && x < vw && y < vh && x + w > 0 && y + h > 0) {
        if (nodes.length >= 256) { clipped = true; reason = "node-cap"; }
        else {
          const identity = id(current);
          if (identity !== null) {
            // Retain the actual viewport intersection rather than shrinking a huge offscreen box.
            const left = max(0, x), top = max(0, y), right = min(vw, x + w), bottom = min(vh, y + h);
            add(nodes, plain({ id: identity, kind: kind(current), rect: tuple<[number, number, number, number]>([left, top, max(0, right - left), max(0, bottom - top)]), paint: paint(current) }));
          }
          else clipped = true;
        }
      }
      if (visited === 2000) { clipped = true; reason = "visit-cap"; break; }
      current = apply(walkNext, walker, []) as Element | null;
    }
    if (current || root() !== documentRoot) clipped = true;
    if (clipped) { loss = true; dropped = null; }
    emit(plain({ ordinal: 0, epochMs: now(), kind: 0, viewport: tuple<[number, number]>([vw, vh]), visited, clipped, nodes }));
  }
  function tick(): void {
    try { frame(); } catch { lose("unavailable"); end(); }
    if (!stopped) timer = apply(schedule, windowHandle, [tick, 500]) as unknown as number;
  }
  function register(type: string, kind: 1 | 2 | 3 | 4 | 5 | 6 | 7): void {
    const fn = (event: Event): void => {
      try {
        // Native isTrusted is an own nonconfigurable property; synthetic events never enter retention.
        if (!event.isTrusted || stopped) return;
        if (queue.length >= 4) { lose("queue"); return; }
        const target = apply(eventTarget!, event, []) as object | null;
        const identity = target ? id(target) : null;
        let x: number | null = null, y: number | null = null;
        if (kind === 1 || kind === 2) {
          const px = apply(clientX!, event, []) as number, py = apply(clientY!, event, []) as number;
          if (finite(px) && finite(py)) { x = min(1920, max(0, px)); y = min(1080, max(0, py)); }
        }
        emit(plain({ ordinal: 0, epochMs: now(), kind, target: identity, x, y }));
      } catch { lose("unavailable"); end(); }
    };
    apply(listen, doc, [type, fn, true]); add(listeners, plain({ type, fn }));
  }
  const producer: MaskedProducer = plain({
    pull(token: string, sequence: number, documentId: number, ordinalBase: number): string {
      if (token !== secret || !safe(sequence) || sequence < 0 || sequence >= 128 || !safe(documentId) || documentId < 1 || !safe(ordinalBase) || ordinalBase < 0 || ordinalBase > 8192) throw new NativeError("Recorder authority refused");
      flush();
      const events = apply(shift, queue, []) as RecordingBatch["events"] | undefined;
      let batch: string | null = null;
      if (events) {
        for (let i = 0; i < events.length; i++) events[i].ordinal += ordinalBase;
        if (events[events.length - 1].ordinal > 8192) { lose("capacity"); end(); }
        else batch = stringify(plain({ version: 1, document: documentId, sequence, dropped, loss, events }));
      }
      // A primitive encoded envelope avoids consulting poisoned page object serializers on transport.
      return stringify(plain({ batch, loss, dropped, stopped, reason, clock: plain({ anchorEpochMs: originEpoch, nowEpochMs: now(), monotonicElapsedMs: max(0, (apply(perfNow, perf, []) as number) - originPerf) }) }));
    },
    stop(token: string): void { if (token !== secret) throw new NativeError("Recorder authority refused"); end(); },
    discard(token: string): void { if (token !== secret) throw new NativeError("Recorder authority refused"); end(); queue.length = 0; pending.length = 0; bytes = 0; },
  });
  freeze(producer);
  if (config.publish !== false) define(windowHandle, key, { value: producer, configurable: false, writable: false, enumerable: false });
  register("pointermove", 1); register("click", 2); register("input", 3); register("change", 4); register("focusin", 5); register("scroll", 6); register("keydown", 7);
  emit(plain({ ordinal: 0, epochMs: now(), kind: 8, target: null, x: null, y: null }));
  tick();
  return producer;
}

type SelectedMethod = "Page.createIsolatedWorld" | "Runtime.evaluate" | "Runtime.callFunctionOn" | "Runtime.releaseObject";
export interface SelectedRecorderClient { send(method: SelectedMethod, params: Record<string, unknown>): Promise<unknown> }
export interface SelectedRecorderAuthority { readonly mainFrameId: string; assertCurrent(): void }
export type SelectedRecorder = { pull(sequence: number, document: number, ordinalBase: number): Promise<ProducerPull>; stop(): Promise<void>; close(): Promise<{ discarded: boolean; released: boolean; joined: boolean }> };
function nativeObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new RecordingInputError("Native selected recorder response unavailable", 503);
  return value as Record<string, unknown>;
}
function opaque(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_.:-]{1,128}$/.test(value)) throw new RecordingInputError("Native selected recorder identity unavailable", 503);
  return value;
}

/** Caller supplies the actual selected native main-frame authority, never a request-chosen frame or script. */
export async function createSelectedMaskedRecorder(client: SelectedRecorderClient, authority: SelectedRecorderAuthority, config: RecorderInstall): Promise<SelectedRecorder> {
  authority.assertCurrent(); const frameId = opaque(authority.mainFrameId);
  if (!/^[a-f0-9]{64}$/.test(config.secret) || !/^__rp_[a-f0-9]{32}$/.test(config.key)) throw new RecordingInputError("Invalid host recorder identity");
  const hostKey = config.key, hostSecret = config.secret;
  let objectId: string | undefined, closed = false, closing: Promise<{ discarded: boolean; released: boolean; joined: boolean }> | undefined;
  const pending = new Set<Promise<unknown>>();
  // Two outstanding native protocol calls at most, including cleanup. Timeout never implies a joined call.
  async function send(method: SelectedMethod, params: Record<string, unknown>): Promise<unknown> {
    if (pending.size >= 2) throw new RecordingInputError("Selected recorder native pressure unavailable", 503);
    const task = client.send(method, params); pending.add(task);
    let expired = false;
    void task.then(value => {
      pending.delete(task);
      if (expired && method === "Runtime.evaluate") {
        try {
          const reply = nativeObject(value), remote = nativeObject(reply.result);
          if (reply.exceptionDetails === undefined && remote.type === "object") {
            // A timed-out installation may still return its own object later. It can only be discarded.
            objectId = opaque(remote.objectId);
            if (closed) { closing = undefined; void close(); }
          }
        } catch {}
      }
    }, () => pending.delete(task));
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { return await Promise.race([task, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => { expired = true; reject(new RecordingInputError("Selected recorder native response timed out", 503)); }, 5000); })]); }
    finally { clearTimeout(timer); }
  }
  function current() {
    if (closed) throw new RecordingInputError("Selected recording authority closed", 409);
    try { authority.assertCurrent(); } catch { throw new RecordingInputError("Selected recording authority changed", 409); }
  }
  const close = () => closing ??= (async () => {
    closed = true; const owned = objectId; objectId = undefined;
    let discarded = false, released = false;
    if (owned) {
      // Revocation permits cleanup of this captured object only; it cannot select or install another realm.
      try { const reply = nativeObject(await send("Runtime.callFunctionOn", { objectId: owned, functionDeclaration: "function(secret){this.discard(secret)}", arguments: [{ value: hostSecret }], returnByValue: true, silent: true })); discarded = reply.exceptionDetails === undefined; } catch {}
      try { await send("Runtime.releaseObject", { objectId: owned }); released = true; } catch {}
    }
    return { discarded, released, joined: pending.size === 0 };
  })();
  let operating = false;
  async function operation(functionDeclaration: string, args: unknown[]): Promise<Record<string, unknown>> {
    // Refuse concurrent observation before dispatch; do not close the legitimate in-flight operation.
    if (operating) throw new RecordingInputError("Selected recorder operation is busy", 409);
    operating = true;
    try {
      current();
      const reply = nativeObject(await send("Runtime.callFunctionOn", { objectId, functionDeclaration, arguments: args.map(value => ({ value })), returnByValue: true, silent: true }));
      current(); if (reply.exceptionDetails !== undefined) throw new RecordingInputError("Selected recorder native operation unavailable", 503);
      return nativeObject(reply.result);
    } catch (cause) { await close(); throw cause instanceof RecordingInputError ? cause : new RecordingInputError("Selected recorder native operation unavailable", 503); }
    finally { operating = false; }
  }
  try {
    const world = nativeObject(await send("Page.createIsolatedWorld", { frameId, worldName: `runphantom-masked-${hostKey}`, grantUniveralAccess: false }));
    current(); const contextId = world.executionContextId;
    if (!Number.isSafeInteger(contextId) || (contextId as number) < 1) throw new RecordingInputError("Selected native realm unavailable", 503);
    current();
    // Fixed Run Phantom source and host-generated hexadecimal identity; no caller executable payload.
    const evaluation = nativeObject(await send("Runtime.evaluate", { contextId, expression: `(${installMaskedRecorder.toString()})(${JSON.stringify({ key: hostKey, secret: hostSecret, publish: false })})`, returnByValue: false, silent: true, timeout: 5000 }));
    if (evaluation.exceptionDetails !== undefined) throw new RecordingInputError("Selected native recorder installation unavailable", 503);
    const remote = nativeObject(evaluation.result); if (remote.type !== "object") throw new RecordingInputError("Selected native recorder object unavailable", 503);
    // Retain only the owned object ID for cleanup before checking an after-await revocation.
    objectId = opaque(remote.objectId); current();
    return {
      async pull(sequence, document, ordinalBase) {
        const result = await operation("function(secret,sequence,document,ordinalBase){return this.pull(secret,sequence,document,ordinalBase)}", [hostSecret, sequence, document, ordinalBase]);
        if (result.type !== "string" || typeof result.value !== "string") { await close(); throw new RecordingInputError("Selected native recorder payload unavailable", 503); }
        try { return parseProducerPull(result.value); } catch { await close(); throw new RecordingInputError("Selected native recorder payload unavailable", 503); }
      },
      async stop() { await operation("function(secret){this.stop(secret)}", [hostSecret]); }, close,
    };
  } catch (cause) { await close(); throw cause instanceof RecordingInputError ? cause : new RecordingInputError("Selected native recorder unavailable", 503); }
}
