/**
 * The Run Phantom browser runtime.
 *
 * Validates its own origin and the daemon's, installs the observers, and executes
 * commands arriving over the session socket. Each observer is installed
 * independently and its success recorded in a coverage map that is sent with the
 * opening `hello`: an observer that fails to install marks its capability false
 * rather than failing the session, which is what lets an assertion return
 * inconclusive instead of a false pass when its evidence was never being collected.
 */
import { PROTOCOL_VERSION, VERIFICATION_LIMITS, type Coverage, type AppCommand } from "../protocol.js";
import { parseCommand, validateOrigin } from "../validation.js";
import { sanitizeWithReport } from "../serialization.js";
import { installConsole } from "./observers/console.js";
import { installNetwork } from "./observers/network.js";
import { installRoute } from "./observers/route.js";
import { observeSafely, type Emit, type Teardown } from "./observers/types.js";
import { runDomCommand } from "./actions/index.js";

export interface ConnectionOptions { url: string; sessionId: string; token: string }
export interface RuntimeConnection {
  disconnect(): void;
  signal(name: string, data?: unknown): void;
  registerStore(name: string, read: () => unknown): () => void;
}
const ACTIVE_RUNTIME = Symbol.for("runphantom.verification.active");
const encoder = new TextEncoder();

function nameValid(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_.:-]{1,128}$/.test(value);
}

export function connect(options: ConnectionOptions): RuntimeConnection {
  validateOrigin(location.origin);
  const origin = validateOrigin(options.url);
  if (!nameValid(options.sessionId)) throw new Error("Invalid verification session ID");
  if (typeof options.token !== "string" || !options.token || options.token.length > 512) {
    throw new Error("Invalid verification session token");
  }
  const globals = window as unknown as Record<symbol, unknown>;
  if (globals[ACTIVE_RUNTIME]) throw new Error("A Run Phantom verification runtime is already connected on this page");
  const lease = {};
  globals[ACTIVE_RUNTIME] = lease;
  const socketUrl = new URL("/verification/ws", origin);
  socketUrl.protocol = socketUrl.protocol === "https:" ? "wss:" : "ws:";
  socketUrl.searchParams.set("sessionId", options.sessionId);
  let socket: WebSocket;
  try { socket = new WebSocket(socketUrl); } catch (error) {
    delete globals[ACTIVE_RUNTIME];
    throw error;
  }
  const stores = new Map<string, () => unknown>();
  const teardown: Teardown[] = [];
  const coverage: Coverage = { network: false, console: false, route: false, dom: true, state: true, signal: true };
  const secrets = new Set<string>([options.token]);
  const secretSpellings = new Set<string>([options.token]);
  const rememberSpelling = (value: string): void => {
    secretSpellings.add(value);
    // JavaScript strings can contain lone surrogates; encoding them is optional redaction.
    try { secretSpellings.add(encodeURIComponent(value)); } catch { /* The raw spelling remains scrubbed. */ }
  };
  rememberSpelling(options.token);
  let secretCharacters = options.token.length;
  let active = true;
  let ready = false;
  let currentActionId: string | undefined;
  let sending = false;
  const earlyEvents: unknown[] = [];
  let earlyBytes = 0;

  // A filled value can reappear in an app's logs, URLs, stores or text. Redact exact values
  // throughout this connection before wire encoding, even when they have no credential shape.
  const prepare = (value: unknown): { value: unknown; truncated: boolean } => {
    const scrubString = (text: string): string => {
      let result = text;
      for (const spelling of secretSpellings) {
        if (result === spelling || (spelling.length >= 4 && result.includes(spelling))) {
          result = result.split(spelling).join("[REDACTED]");
        }
      }
      return result;
    };
    const safe = sanitizeWithReport(value, { scrubString });
    const encoded = JSON.stringify(safe.value);
    return {
      value: safe.value,
      truncated: Boolean(safe.truncation || safe.redacted || /\[(?:TRUNCATED|UNSERIALIZABLE|REDACTED|CIRCULAR)\]/.test(encoded)),
    };
  };
  const send = (message: unknown): boolean => {
    if (!active || socket.readyState !== WebSocket.OPEN) return false;
    const text = JSON.stringify(message);
    if (encoder.encode(text).byteLength > VERIFICATION_LIMITS.MAX_FRAME_BYTES) return false;
    socket.send(text);
    return true;
  };
  const prepareEvent = (type: string, data: Record<string, unknown>): { value: Record<string, unknown>; truncated: boolean } => {
    // Protocol discriminants and request/store/signal identities are generated metadata.
    // A fill equal to "error" or "GET" must not rewrite that metadata or its field names.
    const fields = type === "console" ? ["message", "stack"]
      : type === "network" || type === "network.start" ? ["url", "error"]
      : type === "route" ? ["url"]
      : type === "signal" ? ["data"]
      : type === "observer.error" ? ["message"] : [];
    const value: Record<string, unknown> = {};
    let truncated = false;
    for (const [field, item] of Object.entries(data)) {
      if (fields.includes(field)) {
        const safe = prepare(item);
        value[field] = safe.value;
        truncated ||= safe.truncated;
      } else {
        // User-chosen names still receive known-credential redaction, while ordinary
        // reserved words do not inherit the connection's exact-fill substitutions.
        const safe = sanitizeWithReport(item);
        value[field] = safe.value;
        truncated ||= Boolean(safe.truncation || safe.redacted);
      }
    }
    return { value, truncated };
  };
  const emit: Emit = (type, data, actionId = currentActionId, truncated = false): void => observeSafely(() => {
    if (!active) return;
    // A final lost error cannot wait for a future event to disclose the gap.
    if (sending || socket.bufferedAmount > VERIFICATION_LIMITS.MAX_FRAME_BYTES * 2) { disconnect(); return; }
    sending = true;
    try {
      const safe = prepareEvent(type, data);
      const event = { type, data: safe.value, ...(actionId ? { actionId } : {}), ...(safe.truncated || truncated ? { truncated: true } : {}) };
      const bytes = encoder.encode(JSON.stringify(event)).byteLength;
      if (bytes > VERIFICATION_LIMITS.MAX_EVENT_BYTES) { disconnect(); return; }
      const message = { type: "event", event };
      if (!ready) {
        if (earlyEvents.length >= 100 || earlyBytes + bytes > VERIFICATION_LIMITS.MAX_FRAME_BYTES) { disconnect(); return; }
        earlyEvents.push(message);
        earlyBytes += bytes;
      } else if (!send(message)) disconnect();
    } finally { sending = false; }
  }, () => disconnect());

  const disconnect = (): void => {
    if (!active) return;
    active = false;
    ready = false;
    clearTimeout(handshakeTimer);
    for (const cleanup of teardown.reverse()) observeSafely(cleanup);
    teardown.length = 0;
    stores.clear();
    secrets.clear();
    secretSpellings.clear();
    earlyEvents.length = 0;
    socket.removeEventListener("open", onOpen);
    socket.removeEventListener("message", onMessage);
    socket.removeEventListener("close", disconnect);
    socket.removeEventListener("error", disconnect);
    observeSafely(() => socket.close(1000, "Runtime disconnected"));
    if (globals[ACTIVE_RUNTIME] === lease) delete globals[ACTIVE_RUNTIME];
  };
  const handshakeTimer = setTimeout(disconnect, VERIFICATION_LIMITS.HELLO_TIMEOUT_MS + 3000);
  const install = (name: "console" | "network" | "route", callback: () => Teardown): void => {
    try { teardown.push(callback()); coverage[name] = true; } catch { coverage[name] = false; }
  };
  const onOpen = (): void => {
    if (!active) return;
    install("console", () => installConsole(emit, prepare));
    install("network", () => installNetwork(emit, () => currentActionId));
    install("route", () => installRoute(emit));
    observeSafely(() => send({ type: "hello", version: PROTOCOL_VERSION, token: options.token, coverage }), disconnect);
  };
  const act = (id: string, command: AppCommand): void => {
    try {
      if (command.type === "fill" && command.value && !secrets.has(command.value)) {
        if (secretCharacters + command.value.length > 1024 * 1024 || secrets.size >= 1000) {
          throw new Error("Live fill redaction capacity reached; reconnect before another fill");
        }
        secrets.add(command.value);
        rememberSpelling(command.value);
        secretCharacters += command.value.length;
      }
      if (command.type === "click" || command.type === "fill") {
        currentActionId = id;
        emit("action.boundary", {}, id);
        if (!active || !ready) throw new Error("Verification disconnected before action dispatch");
      }
      let output: { result: unknown; truncated?: boolean };
      if (command.type === "state") {
        const read = stores.get(command.store);
        if (!read) throw new Error("Requested store is not registered");
        const safe = prepare(read());
        const store = sanitizeWithReport(command.store);
        output = { result: { store: store.value, value: safe.value }, truncated: Boolean(safe.truncated || store.truncation || store.redacted) };
      } else output = runDomCommand(command, prepare);
      // DOM commands redact their text fields before returning. Apply generic size limits
      // to the result envelope without exact-fill rewriting of its typed schema.
      const safe = command.type === "state" ? { value: output.result } : sanitizeWithReport(output.result);
      if (!send({ type: "result", id, ok: true, result: safe.value, ...(output.truncated || safe.truncation || safe.redacted ? { truncated: true } : {}) })) disconnect();
    } catch (error) {
      const safe = prepare(error instanceof Error ? error.message : "Runtime command failed");
      send({ type: "result", id, ok: false, error: String(safe.value).slice(0, 1000) });
    }
  };
  const onMessage = (event: MessageEvent): void => {
    try {
      if (typeof event.data !== "string" || encoder.encode(event.data).byteLength > VERIFICATION_LIMITS.MAX_FRAME_BYTES) {
        disconnect(); return;
      }
      const message = JSON.parse(event.data) as Record<string, unknown>;
      if (!message || typeof message !== "object" || Array.isArray(message)) { disconnect(); return; }
      if (message.type === "ready" && Object.keys(message).length === 1 && !ready) {
        ready = true;
        clearTimeout(handshakeTimer);
        for (const queued of earlyEvents) if (!send(queued)) { disconnect(); return; }
        earlyEvents.length = 0;
        earlyBytes = 0;
        return;
      }
      if (!ready || message.type !== "command" || !nameValid(message.id) || Object.keys(message).some((key) => !["type", "id", "command"].includes(key))) {
        disconnect(); return;
      }
      const command = parseCommand(message.command);
      act(message.id, command);
    } catch { disconnect(); }
  };
  socket.addEventListener("open", onOpen);
  socket.addEventListener("message", onMessage);
  socket.addEventListener("close", disconnect);
  socket.addEventListener("error", disconnect);
  return {
    disconnect,
    signal(name, data): void {
      if (!active) throw new Error("Verification runtime is disconnected");
      if (!nameValid(name)) throw new Error("Signal name must be 1–128 letters, digits or ._:-");
      emit("signal", { name, ...(data === undefined ? {} : { data }) });
    },
    registerStore(name, read): () => void {
      if (!active) throw new Error("Verification runtime is disconnected");
      if (!nameValid(name) || typeof read !== "function") throw new Error("A valid store name and reader function are required");
      if (stores.has(name)) throw new Error("Store name is already registered");
      if (stores.size >= 100) throw new Error("Registered store limit reached");
      stores.set(name, read);
      return () => { if (stores.get(name) === read) stores.delete(name); };
    },
  };
}
