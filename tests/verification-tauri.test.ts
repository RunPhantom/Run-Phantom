import { afterEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, realpathSync, lstatSync, writeFileSync, renameSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { CooperatingTauriAdapter, TauriArtifactStore, TauriError, TauriProcessTransport, type TauriRequest, type TauriTransport } from "../src/verification/adapters/tauri";
import { parseReply, record } from "../src/verification/adapters/tauri/contract";

const registration = { application: "dev.runphantom.tauri-fixture", window: "verification-fixture", nonce: "a".repeat(64), actions: ["increment", "reset"] };
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aP1sAAAAASUVORK5CYII=", "base64");
const roots: string[] = [];
const adapters: CooperatingTauriAdapter[] = [];
function root(): string { const value = realpathSync(mkdtempSync(path.join(tmpdir(), "rp-tauri-control-"))); roots.push(value); return value; }
function reply(request: TauriRequest, payload: Record<string, unknown> = { observation: { source: "cooperating-tauri", value: 0, sequence: 0 } }): unknown {
  const { kind: _kind, ...identity } = request;
  delete (identity as Record<string, unknown>).action; delete (identity as Record<string, unknown>).mode; delete (identity as Record<string, unknown>).consent;
  return { ...identity, status: "ok", ...payload };
}
function fixture(exchange: TauriTransport["exchange"] = request => Promise.resolve(reply(request)), close: TauriTransport["close"] = () => Promise.resolve(true)): CooperatingTauriAdapter {
  const adapter = new CooperatingTauriAdapter(registration, { exchange, close }, new TauriArtifactStore(path.join(root(), "captures"))); adapters.push(adapter); return adapter;
}
async function code(operation: Promise<unknown>): Promise<string> { try { await operation; return "unexpected-success"; } catch (error) { expect(error).toBeInstanceOf(TauriError); return (error as TauriError).code; } }
afterEach(async () => {
  for (const adapter of adapters.splice(0)) { try { await adapter.close(); } catch { /* Tests explicitly verify retained unknown ownership before private harness removal. */ } }
  for (const directory of roots.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("cooperating Tauri authority and result provenance", () => {
  test("actual observation determines pass and fail, never framework availability", async () => {
    const adapter = fixture(); expect(await adapter.compare(0)).toMatchObject({ status: "pass", source: "cooperating-tauri" });
    expect(await adapter.compare(1)).toMatchObject({ status: "fail" });
  });
  test("only host-registered actions dispatch; no arbitrary evaluate or OS command", async () => {
    let calls = 0; const adapter = fixture(request => { calls++; return Promise.resolve(reply(request)); });
    expect(await code(adapter.action("shell"))).toBe("denied"); expect(calls).toBe(0);
    await adapter.action("increment"); expect(calls).toBe(1);
  });
  test.each(["application", "window", "nonce", "id", "generation", "version"])("reply %s cannot cross the registered authority", async key => {
    const adapter = fixture(request => Promise.resolve({ ...reply(request) as object, [key]: "foreign-canary" }));
    expect(await code(adapter.observe())).toBe("invalid-reply");
  });
  test("unknown fields, incomplete observations, and accessors are rejected without running getters", async () => {
    const adapter = fixture(request => Promise.resolve({ ...reply(request) as object, privatePath: "/private/canary" }));
    expect(await code(adapter.observe())).toBe("invalid-reply");
    const request: TauriRequest = { ...registration, version: 1, id: "test", generation: 0, kind: "observe" };
    let accessed = false;
    const hostile = Object.defineProperty({}, "nonce", { get() { accessed = true; throw new Error("canary"); } });
    expect(() => parseReply(hostile, request)).toThrow(TauriError); expect(accessed).toBe(false);
    expect(() => parseReply(reply(request, { observation: { source: "cooperating-tauri", value: 0 } }), request)).toThrow(TauriError);
  });
  test.each(["unavailable", "denied", "cancelled"] as const)("native %s remains a typed non-pass outcome", async status => {
    const adapter = fixture(request => { const value = reply(request, {}); return Promise.resolve({ ...value as object, status }); });
    expect(await code(adapter.compare(0))).toBe(status);
  });
  test("arbitrary transport errors cannot leak private text", async () => {
    const adapter = fixture(() => Promise.reject(new Error("secret/path/provider-canary")));
    try { await adapter.observe(); throw new Error("unexpected-success"); } catch (error) { expect(String(error)).not.toContain("canary"); expect((error as TauriError).code).toBe("unavailable"); }
  });
});

describe("complete Tauri object boundary", () => {
  test("plain JSON remains accepted and observations are independent data snapshots", async () => {
    const original = { source: "cooperating-tauri", value: 4, sequence: 2 };
    const adapter = fixture(request => Promise.resolve(JSON.parse(JSON.stringify(reply(request, { observation: original })))));
    expect(await adapter.compare(4)).toMatchObject({ status: "pass", observation: original });
    const snapshot = record(original); expect(snapshot).not.toBe(original); original.value = 9; expect(snapshot.value).toBe(4);
  });
  test.each(["reply", "observation"] as const)("%s rejects symbol and hidden data properties", async scope => {
    for (const hidden of [false, true]) {
      const adapter = fixture(request => {
        const value = reply(request) as Record<string, unknown>, target = scope === "reply" ? value : value.observation as object;
        Object.defineProperty(target, hidden ? "hiddenCanary" : Symbol("dataCanary"), { value: "private-canary", enumerable: !hidden });
        return Promise.resolve(value);
      });
      expect(await code(adapter.observe())).toBe("invalid-reply");
    }
  });
  test.each([
    ["reply", "string", true], ["reply", "symbol", true], ["reply", "string", false], ["reply", "symbol", false],
    ["observation", "string", true], ["observation", "symbol", true], ["observation", "string", false], ["observation", "symbol", false],
  ] as const)("%s %s accessor (enumerable %s) never executes or escapes", async (scope, keyKind, enumerable) => {
    let getters = 0;
    const adapter = fixture(request => {
      const value = reply(request) as Record<string, unknown>, target = scope === "reply" ? value : value.observation as object;
      Object.defineProperty(target, keyKind === "string" ? "accessorCanary" : Symbol("accessorCanary"), { enumerable, get() { getters++; throw new Error("raw-accessor-private-canary"); } });
      return Promise.resolve(value);
    });
    expect(await code(adapter.observe())).toBe("invalid-reply"); expect(getters).toBe(0);
  });
  test.each(["getPrototypeOf", "ownKeys", "getOwnPropertyDescriptor", "get"] as const)("Proxy %s traps are rejected before reflection and capture dispatch", async trap => {
    let traps = 0, dispatched = 0;
    const hostile = new Proxy({ mode: "private-raw", consent: true }, { [trap]: () => { traps++; throw new Error("raw-proxy-private-canary"); } });
    const adapter = fixture(request => { dispatched++; return Promise.resolve(reply(request, { png })); });
    expect(await code(adapter.capture(hostile as never))).toBe("invalid-reply"); expect(traps).toBe(0); expect(dispatched).toBe(0);
  });
  test("nested observation Proxy cannot execute a post-validation getter", async () => {
    let gets = 0;
    const adapter = fixture(request => Promise.resolve(reply(request, { observation: new Proxy({ source: "cooperating-tauri", value: 0, sequence: 0 }, { get() { gets++; throw new Error("raw-observation-private-canary"); } }) })));
    expect(await code(adapter.observe())).toBe("invalid-reply"); expect(gets).toBe(0);
  });
  test("revoked Proxy input and hostile rejected errors become fixed typed failures", async () => {
    const revoked = Proxy.revocable({}, {}); revoked.revoke();
    expect(() => record(revoked.proxy)).toThrow(TauriError);
    let traps = 0; const hostile = new Proxy(new Error("private-canary"), { getPrototypeOf() { traps++; throw new Error("raw-rejection-private-canary"); }, get() { traps++; throw new Error("raw-rejection-get-private-canary"); } });
    const adapter = fixture(() => Promise.reject(hostile));
    expect(await code(adapter.observe())).toBe("unavailable"); expect(traps).toBe(0);
  });
  test("registration accessors never run before authority validation", () => {
    let getters = 0; const hostile = { ...registration };
    Object.defineProperty(hostile, "application", { enumerable: true, get() { getters++; throw new Error("raw-registration-private-canary"); } });
    const store = new TauriArtifactStore(path.join(root(), "captures"));
    expect(() => new CooperatingTauriAdapter(hostile, { exchange: () => Promise.reject(new Error("unused")), close: () => Promise.resolve(true) }, store)).toThrow(TauriError);
    expect(getters).toBe(0); expect(store.close()).toBe(true);
  });
  test.each(["symbol", "index-accessor", "proxy"] as const)("registered action arrays reject %s before reading executable properties", kind => {
    let gets = 0; const actions = ["increment"];
    if (kind === "symbol") Object.defineProperty(actions, Symbol("private-action-canary"), { value: "unexpected" });
    if (kind === "index-accessor") Object.defineProperty(actions, "0", { enumerable: true, get() { gets++; throw new Error("raw-action-private-canary"); } });
    const input = kind === "proxy" ? new Proxy(actions, { get() { gets++; throw new Error("raw-array-proxy-private-canary"); } }) : actions;
    const store = new TauriArtifactStore(path.join(root(), "captures"));
    expect(() => new CooperatingTauriAdapter({ ...registration, actions: input }, { exchange: () => Promise.reject(new Error("unused")), close: () => Promise.resolve(true) }, store)).toThrow(TauriError);
    expect(gets).toBe(0); expect(store.close()).toBe(true);
  });
  test("rejected error code getters are never read or reused", async () => {
    let gets = 0; const error = new TauriError("denied");
    Object.defineProperty(error, "code", { get() { gets++; throw new Error("raw-code-private-canary"); } });
    const adapter = fixture(() => Promise.reject(error));
    expect(await code(adapter.observe())).toBe("unavailable"); expect(gets).toBe(0);
  });
  test("binary capture copies intrinsic bytes without consulting byteLength accessors", async () => {
    let gets = 0; const bytes = new Uint8Array(png);
    Object.defineProperty(bytes, "byteLength", { get() { gets++; throw new Error("raw-png-private-canary"); } });
    const adapter = fixture(request => Promise.resolve(reply(request, { png: bytes })));
    const capture = await adapter.capture({ mode: "private-raw", consent: true });
    expect(capture.bytes).toBe(png.length); expect(gets).toBe(0);
  });
});

describe("generation and owned lifecycle", () => {
  test("one pending operation; cancel fences a late raw capture before admission", async () => {
    let resolve!: (value: unknown) => void; let first!: TauriRequest;
    const adapter = fixture(request => request.kind === "cancel" ? Promise.resolve(reply(request, { cancelled: true })) : new Promise(done => { first = request; resolve = done; }));
    const capture = code(adapter.capture({ mode: "private-raw", consent: true }));
    expect(await code(adapter.observe())).toBe("busy");
    await adapter.cancel(); expect(adapter.generation).toBe(1); expect(await capture).toBe("cancelled");
    resolve(reply(first, { png })); await Promise.resolve(); expect(readdirSync(adapter.artifacts.root)).toEqual([]);
  });
  test("close is cached, fences pending work, and confirms actual terminal before deleting files", async () => {
    let terminal!: (value: boolean) => void; let closes = 0;
    const adapter = fixture(request => Promise.resolve(reply(request, { png })), () => { closes++; return new Promise(done => { terminal = done; }); });
    await adapter.capture({ mode: "private-raw", consent: true }); const closed = adapter.close();
    expect(adapter.close()).toBe(closed); expect(readdirSync(adapter.artifacts.root)).toHaveLength(1); expect(closes).toBe(1);
    terminal(true); await closed; expect(await code(adapter.observe())).toBe("closed");
  });
  test("unknown terminal ownership retains private files and reports failure", async () => {
    const adapter = fixture(request => Promise.resolve(reply(request, { png })), () => Promise.resolve(false));
    const capture = await adapter.capture({ mode: "private-raw", consent: true });
    expect(await code(adapter.close())).toBe("cleanup-unconfirmed");
    expect(adapter.artifacts.readPrivate(capture.id, true)).toEqual(png);
  });
  test("the fixed operation deadline fences a never-completing exchange", async () => {
    let aborted = false;
    const adapter = fixture((_request, signal) => { signal.addEventListener("abort", () => { aborted = true; }); return new Promise(() => undefined); });
    expect(await code(adapter.observe())).toBe("deadline"); expect(aborted).toBe(true);
  }, 7000);
});

describe("private raw capture file ownership", () => {
  test("consent is checked before dispatch; no masking or safe-publication claim", async () => {
    let calls = 0; const adapter = fixture(request => { calls++; return Promise.resolve(reply(request, { png })); });
    expect(await code(adapter.capture({ mode: "private-raw", consent: false } as never))).toBe("denied"); expect(calls).toBe(0);
    const meta = await adapter.capture({ mode: "private-raw", consent: true });
    expect(meta).toMatchObject({ mode: "private-raw", source: "owned-tauri-window", width: 1, height: 1 });
    expect(JSON.stringify(meta)).not.toContain(adapter.artifacts.root);
    expect(lstatSync(adapter.artifacts.root).mode & 0o777).toBe(0o700);
    expect(lstatSync(path.join(adapter.artifacts.root, `${meta.id}.png`)).mode & 0o777).toBe(0o600);
  });
  test("malformed or oversized dimensions never write a file", () => {
    const store = new TauriArtifactStore(path.join(root(), "captures")); const wide = Buffer.from(png); wide.writeUInt32BE(1921, 16);
    expect(() => store.admit(wide, 0)).toThrow(TauriError); expect(() => store.admit(Buffer.from("not-png"), 0)).toThrow(TauriError);
    expect(readdirSync(store.root)).toEqual([]); expect(store.close()).toBe(true);
  });
  test("capacity is bounded and existing files survive rejection", () => {
    const store = new TauriArtifactStore(path.join(root(), "captures"));
    for (let n = 0; n < 16; n++) store.admit(png, 0);
    expect(() => store.admit(png, 0)).toThrow("capacity"); expect(readdirSync(store.root)).toHaveLength(16); expect(store.close()).toBe(true);
  });
  test("replaced files and unrelated controls are retained, never erased", () => {
    const store = new TauriArtifactStore(path.join(root(), "captures")), meta = store.admit(png, 0), file = path.join(store.root, `${meta.id}.png`);
    renameSync(file, `${file}.original`); writeFileSync(file, "unrelated-control", { mode: 0o600 });
    expect(() => store.readPrivate(meta.id, true)).toThrow(TauriError); expect(store.close()).toBe(false);
    expect(readFileSync(file, "utf8")).toBe("unrelated-control");
  });
  test("symlinks cannot turn private reads or cleanup into access to an unrelated file", () => {
    const parent = root(), control = path.join(parent, "control"); writeFileSync(control, "private-canary");
    const store = new TauriArtifactStore(path.join(parent, "captures")), meta = store.admit(png, 0), file = path.join(store.root, `${meta.id}.png`);
    renameSync(file, `${file}.original`); symlinkSync(control, file);
    expect(() => store.readPrivate(meta.id, true)).toThrow(TauriError); expect(store.close()).toBe(false); expect(readFileSync(control, "utf8")).toBe("private-canary");
  });
});

test("real owned synthetic child carries bounded IPC and is terminal-confirmed; this is not a Tauri runtime test", async () => {
  const script = `let text='';process.stdin.on('data',chunk=>{text+=chunk;let end;while((end=text.indexOf('\\n'))>=0){const r=JSON.parse(text.slice(0,end));text=text.slice(end+1);delete r.kind;process.stdout.write('RP_TAURI_V1 '+JSON.stringify({...r,status:'ok',observation:{source:'cooperating-tauri',value:7,sequence:2}})+'\\n')}});`;
  const child = spawn(process.execPath, ["--no-env-file", "-e", script], { env: { PATH: process.env.PATH, HOME: root() }, stdio: "pipe" });
  const transport = new TauriProcessTransport(child), adapter = new CooperatingTauriAdapter(registration, transport, new TauriArtifactStore(path.join(root(), "captures"))); adapters.push(adapter);
  expect(await adapter.compare(7)).toMatchObject({ status: "pass" }); await adapter.close();
  expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
});

test("TERM-resistant owned child requires actual KILL exit while an unrelated control stays alive", async () => {
  const control = spawn(process.execPath, ["--no-env-file", "-e", "setInterval(()=>{},1000)"], { env: { PATH: process.env.PATH, HOME: root() }, stdio: "pipe" });
  const controlOwner = new TauriProcessTransport(control);
  const script = `process.on('SIGTERM',()=>{});let text='';process.stdin.on('data',c=>{text+=c;let end;while((end=text.indexOf('\\n'))>=0){const r=JSON.parse(text.slice(0,end));text=text.slice(end+1);delete r.kind;process.stdout.write('RP_TAURI_V1 '+JSON.stringify({...r,status:'ok',observation:{source:'cooperating-tauri',value:0,sequence:0}})+'\\n')}});`;
  const child = spawn(process.execPath, ["--no-env-file", "-e", script], { env: { PATH: process.env.PATH, HOME: root() }, stdio: "pipe" });
  const transport = new TauriProcessTransport(child), adapter = new CooperatingTauriAdapter(registration, transport, new TauriArtifactStore(path.join(root(), "captures"))); adapters.push(adapter);
  try {
    await adapter.observe(); const started = performance.now(); await adapter.close();
    expect(performance.now() - started).toBeGreaterThanOrEqual(2400); expect(child.signalCode).toBe("SIGKILL");
    expect(control.exitCode).toBeNull(); expect(control.signalCode).toBeNull(); expect(process.kill(control.pid!, 0)).toBe(true);
  } finally { expect(await controlOwner.close()).toBe(true); }
}, 8000);

test("a real spawn failure is typed unavailable and close still confirms no process", async () => {
  const child = spawn(path.join(root(), "absent-owned-fixture"), [], { env: { PATH: "/usr/bin:/bin", HOME: root() }, stdio: "pipe" });
  const transport = new TauriProcessTransport(child), adapter = new CooperatingTauriAdapter(registration, transport, new TauriArtifactStore(path.join(root(), "captures"))); adapters.push(adapter);
  expect(await code(adapter.observe())).toBe("unavailable"); await adapter.close(); expect(child.pid).toBeUndefined();
});
