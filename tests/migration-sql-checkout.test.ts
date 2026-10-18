import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const sqlPath = "drizzle/0007_evidence_storage.sql";
const canonicalBytes = 6737;
const canonicalSha256 = "aef0ee70d71c0ba6bd84061cdd07032455e18f688f0aef2938050be29e00b586";
const crlfBytes = 6873;
const crlfSha256 = "d9335938a2aeaacf9541b1faf2b2b5d4b08307003bec20449022428ce1eb7ad6";
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

// This new test owns at most 10s of Git work; the 15s parent also covers cleanup.
// Existing migration and product deadlines remain unchanged.
test("canonical migration SQL survives actual Git checkout conversion settings", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "runphantom-sql-checkout-"));
  const repo = path.join(directory, "repo"), home = path.join(directory, "home");
  const empty = path.join(directory, "empty"), config = path.join(directory, "empty-config");
  const deadline = Date.now() + 10_000;
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: path.join(home, "config"),
    TMPDIR: directory, TMP: directory, TEMP: directory,
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_SYSTEM: config, GIT_CONFIG_GLOBAL: config,
    GIT_ATTR_NOSYSTEM: "1", GIT_TEMPLATE_DIR: empty,
    GIT_CEILING_DIRECTORIES: directory, GIT_TERMINAL_PROMPT: "0",
  };
  // Git for Windows needs its operational OS directory, never ambient Git config.
  if (process.platform === "win32") {
    env.SystemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT;
    env.WINDIR = process.env.WINDIR ?? process.env.windir;
  }
  async function git(autocrlf: "true" | "input" | "false", args: string[]) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error("SQL checkout fixture exceeded its 10s work budget");
    const command = ["-c", `core.autocrlf=${autocrlf}`, "-c", "core.eol=lf", "-c", "core.safecrlf=false",
      "-c", `core.attributesFile=${config}`, "-c", `core.hooksPath=${empty}`, "-c", "core.fsmonitor=false", ...args];
    await new Promise<void>((resolve, reject) => {
      const child = spawn("git", command, { cwd: repo, env, shell: false,
        detached: process.platform !== "win32", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      let failure: Error | undefined, output = "", outputBytes = 0;
      function stop(error: Error) {
        failure ??= error;
        if (child.pid === undefined) return;
        try {
          if (process.platform === "win32") child.kill("SIGKILL");
          else process.kill(-child.pid, "SIGKILL");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") failure = error as Error;
        }
      }
      const timer = setTimeout(() => stop(new Error("Git checkout fixture command exceeded its finite deadline")), Math.min(2000, remaining));
      const capture = (bytes: Buffer) => {
        outputBytes += bytes.length;
        if (outputBytes > 16_384) stop(new Error("Git checkout fixture output exceeded 16KiB"));
        else output += bytes.toString("utf8");
      };
      child.stdout.on("data", capture);
      child.stderr.on("data", capture);
      child.on("error", error => { failure = error; });
      // close joins the killed/finished direct child and its pipes before cleanup.
      child.on("close", (code, signal) => {
        clearTimeout(timer);
        if (failure) reject(failure);
        else if (code !== 0) reject(new Error(`Git fixture failed (${code ?? signal}): ${output}`));
        else resolve();
      });
    });
  }
  try {
    mkdirSync(path.join(repo, "drizzle"), { recursive: true });
    mkdirSync(home, { recursive: true });
    mkdirSync(empty);
    writeFileSync(config, "");
    const source = readFileSync(path.resolve(import.meta.dir, "..", sqlPath));
    expect(source.byteLength).toBe(canonicalBytes);
    expect(digest(source)).toBe(canonicalSha256);
    const attributes = readFileSync(path.resolve(import.meta.dir, "../.gitattributes"), "utf8");
    expect(attributes.split(/\r?\n/)).toContain("drizzle/*.sql text eol=lf");
    const ordinary = Buffer.from("ordinary checkout control\nsecond line\n");
    writeFileSync(path.join(repo, sqlPath), source);
    writeFileSync(path.join(repo, "ordinary.txt"), ordinary);
    // Index canonical LF once without any SQL rule. No commit/user identity needed.
    await git("false", ["init", "--quiet", `--template=${empty}`]);
    mkdirSync(path.join(repo, ".git/info"), { recursive: true });
    writeFileSync(path.join(repo, ".git/info/attributes"), "");
    await git("false", ["add", "--", sqlPath, "ordinary.txt"]);
    const facts: { rule: boolean; autocrlf: string; bytes: number; sha256: string }[] = [];
    for (const [rule, autocrlf] of [[false, "true"], [true, "true"], [true, "input"], [true, "false"]] as const) {
      // An untracked working-tree attributes file is authoritative during checkout.
      writeFileSync(path.join(repo, ".gitattributes"), rule ? attributes : "");
      rmSync(path.join(repo, sqlPath));
      rmSync(path.join(repo, "ordinary.txt"));
      await git(autocrlf, ["checkout-index", "--force", "--", sqlPath, "ordinary.txt"]);
      const actual = readFileSync(path.join(repo, sqlPath));
      const expected = rule ? source : Buffer.from(source.toString("utf8").replaceAll("\n", "\r\n"));
      expect(actual).toEqual(expected);
      expect(actual.byteLength).toBe(rule ? canonicalBytes : crlfBytes);
      expect(digest(actual)).toBe(rule ? canonicalSha256 : crlfSha256);
      expect(readFileSync(path.join(repo, "ordinary.txt")))
        .toEqual(autocrlf === "true" ? Buffer.from(ordinary.toString("utf8").replaceAll("\n", "\r\n")) : ordinary);
      facts.push({ rule, autocrlf, bytes: actual.byteLength, sha256: digest(actual) });
    }
    console.info("migration-sql-checkout", JSON.stringify({ version: 1, facts }));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 15_000);
