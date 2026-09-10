import { describe, expect, test } from "bun:test";
import { buildSlashItems } from "../app/src/components/slash-items";

const loadout = {
  skills: ["review", "deploy", "shared-name"],
  slash_commands: ["/shared-name", "/claude-only"],
};

describe("slash menu items", () => {
  // A name present in both skills and slash_commands produced two identical rows
  // that also collided on their React key (`${value}-${label}`).
  test("a name in both skills and slash_commands appears once", () => {
    const items = buildSlashItems(loadout, "/", "claude");
    expect(items.filter((i) => i.label === "shared-name")).toHaveLength(1);
  });

  test("every rendered key is unique", () => {
    const keys = buildSlashItems(loadout, "/", "claude").map((i) => `${i.value}-${i.label}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  test("distinct entries all survive", () => {
    const labels = buildSlashItems(loadout, "/", "claude").map((i) => i.label);
    for (const expected of ["New chat", "review", "deploy", "shared-name", "/claude-only"]) {
      expect(labels).toContain(expected);
    }
  });

  test("filtering still narrows the list", () => {
    const items = buildSlashItems(loadout, "/depl", "claude");
    expect(items.map((i) => i.label)).toEqual(["deploy"]);
  });

  test("a null loadout yields only the built-in command", () => {
    expect(buildSlashItems(null, "/", "codex").map((i) => i.label)).toEqual(["New chat"]);
  });
});
