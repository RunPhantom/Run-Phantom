import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  getStoredSecret,
  RUNPHANTOM_SECRET_STORE_PATH_ENV,
  setStoredSecret,
} from "../src/secret-store";

const originalStorePath = process.env[RUNPHANTOM_SECRET_STORE_PATH_ENV];
const temporaryRoots: string[] = [];

function temporaryRoot(): string {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "runphantom-secret-store-"));
  temporaryRoots.push(root);
  return root;
}

afterEach(() => {
  if (originalStorePath === undefined) delete process.env[RUNPHANTOM_SECRET_STORE_PATH_ENV];
  else process.env[RUNPHANTOM_SECRET_STORE_PATH_ENV] = originalStorePath;
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe.serial("secret store filesystem security", () => {
  test("repairs owner-controlled legacy permissions before reading or writing", () => {
    const stateDirectory = path.join(temporaryRoot(), "state");
    const storePath = path.join(stateDirectory, "secrets.json");
    fs.mkdirSync(stateDirectory, { mode: 0o755 });
    if (process.platform !== "win32") fs.chmodSync(stateDirectory, 0o755);
    process.env[RUNPHANTOM_SECRET_STORE_PATH_ENV] = storePath;

    expect(getStoredSecret("anthropic")).toBeNull();
    if (process.platform !== "win32") {
      expect(fs.statSync(stateDirectory).mode & 0o777).toBe(0o700);
    }

    setStoredSecret("anthropic", "test-secret");
    expect(getStoredSecret("anthropic")).toBe("test-secret");
    if (process.platform !== "win32") {
      expect(fs.statSync(storePath).mode & 0o777).toBe(0o600);
    }
  });

  test("rejects a symlinked store directory", () => {
    const root = temporaryRoot();
    const target = path.join(root, "target");
    const link = path.join(root, "linked-state");
    fs.mkdirSync(target, { mode: 0o700 });
    fs.symlinkSync(target, link, "dir");
    process.env[RUNPHANTOM_SECRET_STORE_PATH_ENV] = path.join(link, "secrets.json");

    expect(() => getStoredSecret("openai")).toThrow(/symlinked secret-store path component/i);
  });
});
