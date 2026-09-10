import { afterEach, describe, expect, test } from "bun:test";
import { setActiveDaemonPort, _replayExporterInternal } from "../src/agents-config";
import fs from "fs";
import os from "os";
import path from "path";

const resolve = _replayExporterInternal.resolveReplayTraceExporterUrl;
// Must name a path that does not exist. Built from the real tmpdir so the
// absence is genuine on every platform rather than an accident of "/private"
// only existing on macOS.
const NO_PORT_FILE = path.join(fs.realpathSync(os.tmpdir()), "rp-e2e", "definitely-not-a-port-file");

afterEach(() => setActiveDaemonPort(null));

describe("replay trace exporter url", () => {
  // The port file can name a different daemon — a second instance on a fallback
  // port, or a stale file — and the replay agent then shipped its trace there,
  // so the daemon awaiting it timed out with no explanation.
  test("prefers the port this daemon is actually listening on", () => {
    setActiveDaemonPort(6301);
    expect(resolve({}, NO_PORT_FILE)).toBe("http://localhost:6301/v1/");
  });

  test("an explicit RUNPHANTOM_LOCAL_DEBUGGER still wins", () => {
    setActiveDaemonPort(6301);
    expect(resolve({ RUNPHANTOM_LOCAL_DEBUGGER: "http://127.0.0.1:9999/v1/" }, NO_PORT_FILE))
      .toBe("http://127.0.0.1:9999/v1/");
  });

  test("RUNPHANTOM_URL still wins over the live port", () => {
    setActiveDaemonPort(6301);
    expect(resolve({ RUNPHANTOM_URL: "http://127.0.0.1:7777" }, NO_PORT_FILE))
      .toBe("http://127.0.0.1:7777/v1/");
  });

  test("falls back to the default when nothing is known", () => {
    expect(resolve({}, NO_PORT_FILE)).toBe("http://localhost:5947/v1/");
  });

  test("a bogus port is ignored rather than used", () => {
    setActiveDaemonPort(0);
    expect(resolve({}, NO_PORT_FILE)).toBe("http://localhost:5947/v1/");
  });
});
