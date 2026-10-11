import { SEMANTIC_REF_PATTERN } from "../../protocol.js";

export const MAX_LIVE_REFS = 1000;
export const LIVE_REF_TTL_MS = 60_000;
export const LIVE_REF_PATTERN = SEMANTIC_REF_PATTERN;

export class LiveRefError extends Error {
  constructor(message: string) { super(message); this.name = "LiveRefError"; }
}
interface Entry { element: WeakRef<Element>; document: WeakRef<Document>; expires: number }
interface Options { now?: () => number; random?: () => string }

function nonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
}

function inOpenRoot(element: Element): boolean {
  let current: Node = element;
  for (let depth = 0; depth < 64; depth++) {
    const root = current.getRootNode();
    if (root === element.ownerDocument) return true;
    if (root.nodeType !== 11 || !("host" in root)) return false;
    const shadow = root as ShadowRoot;
    if (shadow.mode !== "open" || shadow.host.shadowRoot !== shadow) return false;
    current = shadow.host;
  }
  return false;
}

/** Identity classification within one SDK connection, not independent browser authority. */
export class LiveElementRefs {
  readonly documentGeneration: string;
  readonly #entries = new Map<string, Entry>();
  readonly #issued = new Set<string>();
  readonly #reverse = new WeakMap<Element, string>();
  readonly #now: () => number;
  readonly #random: () => string;
  #active = true;

  constructor(readonly sessionId: string, readonly document: Document, options: Options = {}) {
    if (!/^[A-Za-z0-9._:-]{1,128}$/.test(sessionId)) throw new LiveRefError("Invalid reference session");
    this.#now = options.now ?? (() => performance.now());
    this.#random = options.random ?? nonce;
    this.documentGeneration = this.#nonce();
  }

  get size(): number { this.#prune(); return this.#entries.size; }

  #nonce(): string {
    const value = this.#random();
    if (!/^[0-9a-f]{32}$/.test(value)) throw new LiveRefError("Secure reference generation is unavailable");
    return value;
  }

  #owns(element: Element, owner: Document): boolean {
    try {
      if (!this.#active || element.ownerDocument !== owner || !element.isConnected || !inOpenRoot(element)) return false;
      if (this.document.defaultView?.document !== this.document) return false;
      let current = owner;
      for (let depth = 0; depth < 64; depth++) {
        if (current === this.document) return true;
        const view = current.defaultView;
        const frame = view?.frameElement;
        if (!view || view.document !== current || !frame || !frame.isConnected || !inOpenRoot(frame)
          || !("contentDocument" in frame) || (frame as HTMLIFrameElement).contentDocument !== current) return false;
        current = frame.ownerDocument;
      }
    } catch { return false; }
    return false;
  }

  #prune(): void {
    const now = this.#now();
    for (const [ref, entry] of this.#entries) {
      const element = entry.element.deref();
      const owner = entry.document.deref();
      if (now >= entry.expires || !element || !owner || !this.#owns(element, owner)) this.#entries.delete(ref);
    }
  }

  refFor(element: Element): string {
    if (!this.#owns(element, element.ownerDocument)) throw new LiveRefError("Element is outside the active document scope");
    this.#prune();
    const existing = this.#reverse.get(element);
    if (existing && this.#entries.has(existing)) return existing;
    if (this.#issued.size >= MAX_LIVE_REFS) throw new LiveRefError("Live reference capacity exhausted; reconnect before discovering new references");
    let ref = "";
    for (let attempt = 0; attempt < 8; attempt++) {
      const candidate = `rpref_${this.#nonce()}`;
      if (!this.#issued.has(candidate)) { ref = candidate; break; }
    }
    if (!ref) throw new LiveRefError("Secure reference collision could not be resolved");
    this.#issued.add(ref);
    this.#entries.set(ref, { element: new WeakRef(element), document: new WeakRef(element.ownerDocument), expires: this.#now() + LIVE_REF_TTL_MS });
    this.#reverse.set(element, ref);
    return ref;
  }

  resolve(ref: string): Element {
    if (!LIVE_REF_PATTERN.test(ref)) throw new LiveRefError("Invalid live reference");
    const entry = this.#entries.get(ref);
    const element = entry?.element.deref();
    const owner = entry?.document.deref();
    if (!entry || !element || !owner || this.#now() >= entry.expires || !this.#owns(element, owner)) {
      this.#entries.delete(ref);
      throw new LiveRefError("Live reference is stale, expired, disconnected, or belongs to another session/document");
    }
    return element;
  }

  invalidate(): void { this.#active = false; this.#entries.clear(); this.#issued.clear(); }
}
