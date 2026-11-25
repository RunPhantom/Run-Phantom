import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  deleteStoredSecret,
  getEffectiveSecret,
  getSecretStatus,
  getSecretStatuses,
  parseSecretKey,
  RUNPHANTOM_SECRET_STORE_PATH_ENV,
  setStoredSecret,
} from "../src/secret-store";

const names = [RUNPHANTOM_SECRET_STORE_PATH_ENV, "GEMINI_API_KEY", "GOOGLE_API_KEY"];
const original = new Map(names.map(name => [name, process.env[name]]));
let root = "";

beforeEach(() => {
  for (const name of names) delete process.env[name];
  root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "runphantom-gemini-secret-"));
  process.env[RUNPHANTOM_SECRET_STORE_PATH_ENV] = path.join(root, "state", "secrets.json");
});

afterEach(() => {
  for (const [name, value] of original) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
  fs.rmSync(root, { recursive: true, force: true });
});

describe.serial("Google Gemini key slot", () => {
  test("is a recognised secret key reported alongside the other providers", () => {
    expect(parseSecretKey("gemini")).toBe("gemini");
    expect(parseSecretKey("google")).toBeNull();
    expect(Object.keys(getSecretStatuses()).sort()).toEqual(["anthropic", "gemini", "openai"]);
    expect(getSecretStatus("gemini")).toEqual({ configured: false, source: null, env_var: "GEMINI_API_KEY", stored: false });
  });

  test("stores, reports and clears a key without exposing its value", () => {
    setStoredSecret("gemini", "AIza-fixture-store-value");
    expect(getEffectiveSecret("gemini")).toBe("AIza-fixture-store-value");
    const status = getSecretStatus("gemini");
    expect(status).toEqual({ configured: true, source: "store", env_var: "GEMINI_API_KEY", stored: true });
    expect(JSON.stringify(status)).not.toContain("AIza-fixture");
    deleteStoredSecret("gemini");
    expect(getEffectiveSecret("gemini")).toBeNull();
  });

  test("falls back to GEMINI_API_KEY, then GOOGLE_API_KEY, with the environment taking precedence like other providers", () => {
    process.env.GOOGLE_API_KEY = "google-env-fixture";
    expect(getEffectiveSecret("gemini")).toBe("google-env-fixture");
    expect(getSecretStatus("gemini")).toMatchObject({ source: "env", env_var: "GOOGLE_API_KEY" });
    process.env.GEMINI_API_KEY = "gemini-env-fixture";
    expect(getEffectiveSecret("gemini")).toBe("gemini-env-fixture");
    setStoredSecret("gemini", "stored-fixture");
    expect(getSecretStatus("gemini")).toEqual({ configured: true, source: "env", env_var: "GEMINI_API_KEY", stored: true });
  });
});
