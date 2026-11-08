import { expect, test } from "bun:test";
import path from "node:path";
import { devCommands } from "../scripts/dev";

test("development startup launches the daemon and UI without shell operators", () => {
  const root = path.resolve("fixture with spaces", "repository");
  expect(devCommands(root, "6222")).toEqual([
    { label: "daemon", cmd: [process.execPath, "--watch", "src/index.ts", "serve"], cwd: root, env: { RUNPHANTOM_DEV_UI_ORIGIN: "http://localhost:6222" } },
    { label: "UI", cmd: [process.execPath, "x", "vite", "--force"], cwd: path.join(root, "app") },
  ]);
});
