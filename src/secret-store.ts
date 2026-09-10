import fs from "fs";
import os from "os";
import path from "path";
import { randomBytes } from "node:crypto";

export const RUNPHANTOM_SECRET_STORE_PATH_ENV = "RUNPHANTOM_SECRET_STORE_PATH";

export const SECRET_DEFS = {
  anthropic: {
    label: "Anthropic",
    envVars: ["ANTHROPIC_API_KEY"],
  },
  openai: {
    label: "OpenAI",
    envVars: ["OPENAI_API_KEY", "RUNPHANTOM_OPENAI_API_KEY"],
  },
} as const;

export type SecretKey = keyof typeof SECRET_DEFS;
export type SecretSource = "env" | "store" | null;

export interface SecretStatus {
  configured: boolean;
  source: SecretSource;
  env_var: string;
  // True whenever a value exists in the secret store, independent of whether an
  // env var currently shadows it. Lets the UI expose "Clear" for a stored key
  // even while `source` reports "env".
  stored: boolean;
}

type SecretFile = Partial<Record<SecretKey, string>>;

const SECRET_KEYS = Object.keys(SECRET_DEFS) as SecretKey[];

export function parseSecretKey(value: string): SecretKey | null {
  return SECRET_KEYS.includes(value as SecretKey) ? value as SecretKey : null;
}

export function secretStorePath(): string {
  const explicit = process.env[RUNPHANTOM_SECRET_STORE_PATH_ENV]?.trim();
  return path.resolve(explicit || path.join(os.homedir(), ".runphantom", "secrets.json"));
}

function securityError(message: string): Error {
  return new Error(`[secret-store] ${message}`);
}

function lstatOrNull(target: string): fs.Stats | null {
  try {
    return fs.lstatSync(target);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw securityError(`cannot inspect ${target}: ${(err as Error).message}`);
  }
}

function assertOwnedByCurrentUser(stats: fs.Stats, target: string): void {
  if (typeof process.getuid !== "function") return;
  const uid = process.getuid();
  if (stats.uid !== uid) {
    throw securityError(`${target} is owned by uid ${stats.uid}; expected current uid ${uid}`);
  }
}

function assertMode(stats: fs.Stats, target: string, expected: number): void {
  if (process.platform === "win32") return;
  const actual = stats.mode & 0o777;
  if (actual !== expected) {
    throw securityError(
      `${target} has permissions ${actual.toString(8).padStart(3, "0")}; expected ${expected.toString(8)}`,
    );
  }
}

function pathComponents(absolutePath: string): string[] {
  const root = path.parse(absolutePath).root;
  const relative = absolutePath.slice(root.length);
  const parts = relative.split(path.sep).filter(Boolean);
  const components: string[] = [];
  let current = root;
  for (const part of parts) {
    current = path.join(current, part);
    components.push(current);
  }
  return components;
}

function assertExistingComponentsAreNotSymlinks(absolutePath: string): void {
  for (const component of pathComponents(absolutePath)) {
    const stats = lstatOrNull(component);
    if (!stats) return;
    if (stats.isSymbolicLink()) {
      throw securityError(`refusing symlinked secret-store path component: ${component}`);
    }
  }
}

function ensureSecureDirectory(directory: string): void {
  let stats = lstatOrNull(directory);
  if (!stats) throw securityError(`secret-store directory does not exist: ${directory}`);
  if (stats.isSymbolicLink()) {
    throw securityError(`refusing symlinked secret-store directory: ${directory}`);
  }
  if (!stats.isDirectory()) {
    throw securityError(`secret-store parent is not a directory: ${directory}`);
  }
  assertOwnedByCurrentUser(stats, directory);
  if (process.platform !== "win32" && (stats.mode & 0o777) !== 0o700) {
    const noFollow = fs.constants.O_NOFOLLOW ?? 0;
    const directoryOnly = fs.constants.O_DIRECTORY ?? 0;
    let fd: number;
    try {
      fd = fs.openSync(directory, fs.constants.O_RDONLY | noFollow | directoryOnly);
    } catch (err) {
      throw securityError(`cannot open secret-store directory safely: ${(err as Error).message}`);
    }
    try {
      const opened = fs.fstatSync(fd);
      if (!opened.isDirectory()) {
        throw securityError(`secret-store parent is not a directory: ${directory}`);
      }
      assertOwnedByCurrentUser(opened, directory);
      fs.fchmodSync(fd, 0o700);
      assertMode(fs.fstatSync(fd), directory, 0o700);
    } finally {
      fs.closeSync(fd);
    }
    assertExistingComponentsAreNotSymlinks(directory);
    stats = lstatOrNull(directory);
    if (!stats || !stats.isDirectory() || stats.isSymbolicLink()) {
      throw securityError(`secret-store directory changed while securing it: ${directory}`);
    }
    assertOwnedByCurrentUser(stats, directory);
  }
  assertMode(stats, directory, 0o700);
}

function ensureStoreDirectory(filePath: string): void {
  const directory = path.dirname(filePath);
  assertExistingComponentsAreNotSymlinks(directory);

  for (const component of pathComponents(directory)) {
    if (lstatOrNull(component)) continue;
    try {
      fs.mkdirSync(component, { mode: 0o700 });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
        throw securityError(`cannot create secret-store directory ${component}: ${(err as Error).message}`);
      }
    }
    const created = lstatOrNull(component);
    if (!created || created.isSymbolicLink() || !created.isDirectory()) {
      throw securityError(`secret-store directory creation was intercepted at ${component}`);
    }
  }

  assertExistingComponentsAreNotSymlinks(directory);
  ensureSecureDirectory(directory);
}

function assertSecureStoreFile(stats: fs.Stats, filePath: string): void {
  if (stats.isSymbolicLink()) {
    throw securityError(`refusing symlinked secret store: ${filePath}`);
  }
  if (!stats.isFile()) {
    throw securityError(`secret store is not a regular file: ${filePath}`);
  }
  assertOwnedByCurrentUser(stats, filePath);
  assertMode(stats, filePath, 0o600);
}

function inspectStoreFile(filePath: string): fs.Stats | null {
  assertExistingComponentsAreNotSymlinks(filePath);
  const stats = lstatOrNull(filePath);
  if (stats) assertSecureStoreFile(stats, filePath);
  return stats;
}

function readStore(): SecretFile {
  const filePath = secretStorePath();
  const directory = path.dirname(filePath);
  assertExistingComponentsAreNotSymlinks(filePath);
  if (!lstatOrNull(directory)) return {};
  ensureSecureDirectory(directory);
  if (!inspectStoreFile(filePath)) return {};

  const noFollow = fs.constants.O_NOFOLLOW ?? 0;
  let fd: number;
  try {
    fd = fs.openSync(filePath, fs.constants.O_RDONLY | noFollow);
  } catch (err) {
    throw securityError(`cannot open secret store without following links: ${(err as Error).message}`);
  }

  let raw: string;
  try {
    const opened = fs.fstatSync(fd);
    assertSecureStoreFile(opened, filePath);
    assertExistingComponentsAreNotSymlinks(filePath);
    raw = fs.readFileSync(fd, "utf8");
  } finally {
    fs.closeSync(fd);
  }
  if (!raw.trim()) return {};
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch (err) {
    throw securityError(`secret store contains invalid JSON: ${(err as Error).message}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw securityError("secret store must contain a JSON object");
  }
  const out: SecretFile = {};
  for (const key of SECRET_KEYS) {
    const value = parsed[key];
    if (typeof value === "string" && value.trim()) out[key] = value.trim();
  }
  return out;
}

function writeStore(store: SecretFile): void {
  const filePath = secretStorePath();
  ensureStoreDirectory(filePath);
  inspectStoreFile(filePath);

  const tmp = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`,
  );
  const noFollow = fs.constants.O_NOFOLLOW ?? 0;
  const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | noFollow;
  let fd: number | null = null;
  let renamed = false;
  let failure: Error | null = null;
  try {
    fd = fs.openSync(tmp, flags, 0o600);
    fs.writeFileSync(fd, `${JSON.stringify(store, null, 2)}\n`, "utf8");
    if (process.platform !== "win32") fs.fchmodSync(fd, 0o600);
    const written = fs.fstatSync(fd);
    assertSecureStoreFile(written, tmp);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;

    assertExistingComponentsAreNotSymlinks(filePath);
    inspectStoreFile(filePath);
    fs.renameSync(tmp, filePath);
    renamed = true;
    ensureSecureDirectory(path.dirname(filePath));
    const installed = lstatOrNull(filePath);
    if (!installed) throw securityError(`atomic secret-store replacement did not create ${filePath}`);
    assertSecureStoreFile(installed, filePath);
  } catch (err) {
    failure = err instanceof Error && err.message.startsWith("[secret-store]")
      ? err
      : securityError(`cannot write secret store ${filePath}: ${(err as Error).message}`);
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch (err) {
        failure ??= securityError(`cannot close temporary secret file ${tmp}: ${(err as Error).message}`);
      }
    }
    if (!renamed) {
      try {
        fs.unlinkSync(tmp);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
          failure ??= securityError(`cannot remove temporary secret file ${tmp}: ${(err as Error).message}`);
        }
      }
    }
  }
  if (failure) throw failure;
}

export function getStoredSecret(key: SecretKey): string | null {
  return readStore()[key] ?? null;
}

export function setStoredSecret(key: SecretKey, value: string): void {
  const trimmed = value.trim();
  if (!trimmed) {
    deleteStoredSecret(key);
    return;
  }
  const store = readStore();
  store[key] = trimmed;
  writeStore(store);
}

export function deleteStoredSecret(key: SecretKey): void {
  const store = readStore();
  delete store[key];
  writeStore(store);
}

export function getEnvSecret(key: SecretKey): { value: string; envVar: string } | null {
  for (const envVar of SECRET_DEFS[key].envVars) {
    const value = process.env[envVar]?.trim();
    if (value) return { value, envVar };
  }
  return null;
}

export function getEffectiveSecret(key: SecretKey): string | null {
  return getEnvSecret(key)?.value ?? getStoredSecret(key);
}

export function getSecretStatus(key: SecretKey): SecretStatus {
  const stored = getStoredSecret(key);
  const env = getEnvSecret(key);
  if (env) {
    return { configured: true, source: "env", env_var: env.envVar, stored: !!stored };
  }
  return {
    configured: !!stored,
    source: stored ? "store" : null,
    env_var: SECRET_DEFS[key].envVars[0],
    stored: !!stored,
  };
}

export function getSecretStatuses(): Record<SecretKey, SecretStatus> {
  return Object.fromEntries(
    SECRET_KEYS.map((key) => [key, getSecretStatus(key)]),
  ) as Record<SecretKey, SecretStatus>;
}
