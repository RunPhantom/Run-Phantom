import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createNativeAcpFixture, ownAcpCompiler, type AcpCompilerClose } from "./fixtures/acp-native-launcher";

function directory() {
  return mkdtempSync(path.join(realpathSync(tmpdir()), "runphantom-acp compiler-control-"));
}
function launch(profile: string, script: string) {
  const env: Record<string, string> = { HOME: profile, USERPROFILE: profile, TMPDIR: profile, TMP: profile, TEMP: profile };
  for (const key of ["PATH", "SYSTEMROOT", "WINDIR", "COMSPEC"]) if (process.env[key]) env[key] = process.env[key]!;
  const child = spawn(process.execPath, ["--no-env-file", "-e", script], { cwd: profile, env, stdio: "ignore", detached: process.platform !== "win32" });
  const closed = new Promise<AcpCompilerClose>(resolve => child.once("close", (code, signal) => resolve({ code, signal })));
  return { child, closed };
}
async function bounded<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Native compiler control driver deadline")), milliseconds); })]);
  } finally { clearTimeout(timer); }
}

async function withCleanup(body: () => void | Promise<void>, cleanup: () => void | Promise<void>) {
  let primary: unknown, cleanupError: unknown, failed = false, cleanupFailed = false;
  try { await body(); } catch (error) { primary = error; failed = true; }
  try { await cleanup(); } catch (error) { cleanupError = error; cleanupFailed = true; }
  if (failed && cleanupFailed) throw new AggregateError([primary, cleanupError], "Native compiler control and cleanup both failed");
  if (failed) throw primary;
  if (cleanupFailed) throw cleanupError;
}

test("accepted native kill with held close observation retains ownership until the actual receipt is released", async () => {
  const profile = directory(), owner = ownAcpCompiler(profile);
  const actual = launch(profile, "setInterval(() => {}, 1000)");
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const held = actual.closed.then(async value => { await gate; return value; });
  await withCleanup(async () => {
    let caught: unknown;
    try { await bounded(owner.run(() => ({ child: actual.child, closed: held }), { runMs: 150, confirmationMs: 200 }), 2_000); }
    catch (error) { caught = error; }
    expect(caught).toBe(owner.primaryError);
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe("Controlled ACP compiler deadline");
    await bounded(actual.closed, 1_000);
    expect(owner.ownership()).toMatchObject({ closeObserved: false, terminalConfirmed: false, killAccepted: true, removed: false });
    expect(owner.cleanup().removed).toBe(false);
    expect(existsSync(profile)).toBe(true);
    expect(JSON.parse(readFileSync(path.join(profile, "compiler-ownership.json"), "utf8"))).toMatchObject({ pid: actual.child.pid, closeObserved: false, terminalConfirmed: false, removed: false });
    release(); await held; await Promise.resolve();
    expect(owner.cleanup()).toMatchObject({ closeObserved: true, terminalConfirmed: true, removed: true });
    expect(existsSync(profile)).toBe(false);
  }, async () => {
    release();
    if (actual.child.exitCode === null && actual.child.signalCode === null) {
      if (process.platform === "win32") actual.child.kill("SIGKILL");
      else if (actual.child.pid !== undefined) { try { process.kill(-actual.child.pid, "SIGKILL"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; } }
    }
    await bounded(actual.closed, 1_000); await held; await Promise.resolve();
    if (!owner.cleanup().removed) throw new Error("Native compiler control ownership unconfirmed; directory retained");
  });
}, 5_000);

test("real partial entry setup failure preserves its error identity and removes only the acquired directory", async () => {
  const profile = directory(), owner = createNativeAcpFixture(profile);
  mkdirSync(path.join(profile, "controlled-entry.ts"));
  await withCleanup(async () => {
    let caught: unknown;
    try { await owner.compile(process.execPath); } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(Error);
    expect(caught).toBe(owner.primaryError);
    expect(owner.ownership()).toMatchObject({ pid: null, closeObserved: false, terminalConfirmed: true, killAccepted: null });
    expect(owner.cleanup().removed).toBe(true);
    expect(existsSync(profile)).toBe(false);
  }, () => {
    if (!owner.cleanup().removed) throw new Error("Partial compiler control directory retained");
  });
});

test("actual successful native close permits idempotent owner cleanup", async () => {
  const profile = directory(), owner = ownAcpCompiler(profile);
  const actual = launch(profile, "process.exit(0)");
  await withCleanup(async () => {
    await bounded(owner.run(() => actual, { runMs: 1_000, confirmationMs: 500 }), 2_000);
    expect(owner.ownership()).toMatchObject({ pid: actual.child.pid, closeObserved: true, terminalConfirmed: true, killAccepted: null });
    expect(owner.cleanup().removed).toBe(true);
    expect(owner.cleanup().removed).toBe(true);
    expect(existsSync(profile)).toBe(false);
  }, async () => {
    await bounded(actual.closed, 1_000);
    if (!owner.cleanup().removed) throw new Error("Successful compiler control directory retained");
  });
}, 5_000);

test("directory identity replacement is retained without writing into or removing the replacement", async () => {
  const profile = directory(), original = profile + "-original", owner = ownAcpCompiler(profile);
  renameSync(profile, original); mkdirSync(profile);
  await withCleanup(() => {
    expect(owner.cleanup()).toMatchObject({ removed: false, terminalConfirmed: true });
    expect(existsSync(profile)).toBe(true);
    expect(existsSync(original)).toBe(true);
    expect(existsSync(path.join(profile, "compiler-ownership.json"))).toBe(false);
    expect(owner.secondaryErrors.length).toBeGreaterThan(0);
  }, () => {
    rmSync(profile, { recursive: true, force: true }); rmSync(original, { recursive: true, force: true });
  });
});

test("control cleanup preserves sole unknown throws and both primary and cleanup identities", async () => {
  const primary = new Error("control primary"), cleanup = new Error("control cleanup");
  let caught = false, value: unknown;
  try { await withCleanup(() => { throw primary; }, () => { throw cleanup; }); }
  catch (error) { caught = true; value = error; }
  expect(caught).toBe(true);
  expect(value).toBeInstanceOf(AggregateError);
  expect((value as AggregateError).errors[0]).toBe(primary);
  expect((value as AggregateError).errors[1]).toBe(cleanup);
  for (const side of ["primary", "cleanup"] as const) {
    caught = false; value = "not caught";
    const failure = side === "primary" ? undefined : null;
    const fail = (value: unknown) => { throw value; };
    try { await withCleanup(side === "primary" ? () => fail(failure) : () => {}, side === "cleanup" ? () => fail(failure) : () => {}); }
    catch (error) { caught = true; value = error; }
    expect(caught).toBe(true);
    expect(value).toBe(failure);
  }
});
