import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fuzzyMatchEntry, fuzzyScore } from "../app/src/shell/fuzzy";
import { ariaKeyShortcuts, chordMatches, formatKeys, matchShortcut, parseKeys, type KeyLike } from "../app/src/shell/keyboard";
import { commandDetail, commandStatus, listCommands, listShortcuts, registerCommands, registerShortcuts, type PaletteCommand, type ShortcutDefinition } from "../app/src/shell/commands";
import { buildSections } from "../app/src/shell/palette-model";
import { readOtlpEndpoint } from "../app/src/shell/otlp";
import { resolveTheme } from "../app/src/shell/theme";
import { NAV_GROUPS, NAV_ITEMS, isNavPathActive, sectionLabel } from "../app/src/shell/navigation";

const key = (value: string, modifiers: Partial<KeyLike> = {}): KeyLike => ({ key: value, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...modifiers });
const noop = () => {};
const command = (id: string, label: string, group = "Go to", extra: Partial<PaletteCommand> = {}): PaletteCommand => ({ id, label, group, run: noop, ...extra });
const shortcut = (id: string, keys: string, extra: Partial<ShortcutDefinition> = {}): ShortcutDefinition => ({ id, keys, description: id, scope: "Global", handler: noop, ...extra });

describe("fuzzy matching", () => {
  test("matches subsequences case-insensitively and rejects out-of-order characters", () => {
    expect(fuzzyScore("rvq", "Review queues")).not.toBeNull();
    expect(fuzzyScore("REV", "review queues")?.indices).toEqual([0, 1, 2]);
    expect(fuzzyScore("qr", "Review queues")).toBeNull();
  });

  test("prefers contiguous word-start matches over scattered ones", () => {
    const prefix = fuzzyScore("cost", "Cost & usage")!;
    const scattered = fuzzyScore("cost", "Copy OTLP endpoint settings")!;
    expect(prefix.score).toBeGreaterThan(scattered.score);
  });

  test("keywords match without label highlight indices", () => {
    const match = fuzzyMatchEntry("spend", "Cost & usage", ["spend", "tokens"]);
    expect(match).not.toBeNull();
    expect(match!.indices).toEqual([]);
    expect(fuzzyMatchEntry("zzz", "Cost & usage", ["spend"])).toBeNull();
  });
});

describe("palette sections", () => {
  const commands = [
    command("go:runs", "Runs", "Go to", { order: 0 }),
    command("go:costs", "Cost & usage", "Go to", { order: 1, keywords: ["spend"] }),
    command("run:1", "code_review_agent", "Recent runs", { detail: "2m ago" }),
    command("action:theme", "Toggle theme", "Actions", { keywords: ["dark"] }),
    command("hidden", "Hidden thing", "Actions", { when: () => false }),
    command("search:runs", "Search runs for “x”", "Search", { keywords: ["cost"] }),
  ];

  test("without a query, groups follow the fixed order and hidden commands are dropped", () => {
    const sections = buildSections(commands, "");
    expect(sections.map(section => section.group)).toEqual(["Go to", "Recent runs", "Search", "Actions"]);
    expect(sections.flatMap(section => section.rows.map(row => row.command.id))).not.toContain("hidden");
    expect(sections[0]!.rows.map(row => row.command.id)).toEqual(["go:runs", "go:costs"]);
  });

  test("with a query, the best-matching group leads and server search stays last", () => {
    const sections = buildSections(commands, "cost");
    expect(sections[0]!.group).toBe("Go to");
    expect(sections[0]!.rows[0]!.command.id).toBe("go:costs");
    expect(sections.at(-1)!.group).toBe("Search");
    expect(buildSections(commands, "dark")[0]!.rows[0]!.command.id).toBe("action:theme");
  });

  test("a detail function is read on every build so relative times stay current and matchable", () => {
    let age = "2m ago";
    const aging = [command("run:2", "planner", "Recent runs", { detail: () => age })];
    expect(commandDetail(aging[0]!)).toBe("2m ago");
    expect(buildSections(aging, "2m")).toHaveLength(1);
    age = "1h ago";
    expect(buildSections(aging, "2m")).toHaveLength(0);
    expect(buildSections(aging, "1h")).toHaveLength(1);
    expect(commandDetail(command("go:x", "X"))).toBe("");
  });

  test("a status function is read on every call so a run can leave live without re-registering", () => {
    let live = true;
    const run = command("run:3", "planner", "Recent runs", { status: () => live ? { tone: "live", label: "Live" } : { tone: "unknown", label: "Quiet" } });
    expect(commandStatus(run)).toEqual({ tone: "live", label: "Live" });
    live = false;
    expect(commandStatus(run)?.label).toBe("Quiet");
    expect(commandStatus(command("go:x", "X"))).toBeNull();
  });
});

describe("keyboard chords", () => {
  test("parses modifiers, aliases and sequences", () => {
    expect(parseKeys("mod+k")).toEqual([{ key: "k", mod: true, shift: false, alt: false }]);
    expect(parseKeys("g r").map(chord => chord.key)).toEqual(["g", "r"]);
    expect(parseKeys("g ,")[1]!.key).toBe(",");
    expect(parseKeys("esc")[0]!.key).toBe("escape");
  });

  test("mod is Command on macOS and Control elsewhere", () => {
    const [chord] = parseKeys("mod+k");
    expect(chordMatches(key("k", { metaKey: true }), chord!, true)).toBe(true);
    expect(chordMatches(key("k", { ctrlKey: true }), chord!, true)).toBe(false);
    expect(chordMatches(key("k", { ctrlKey: true }), chord!, false)).toBe(true);
    expect(chordMatches(key("k", { metaKey: true }), chord!, false)).toBe(false);
  });

  test("plain-key chords never fire with a modifier held, and ? ignores the Shift that produces it", () => {
    const [g] = parseKeys("g");
    expect(chordMatches(key("g", { metaKey: true }), g!, true)).toBe(false);
    expect(chordMatches(key("g", { altKey: true }), g!, true)).toBe(false);
    expect(chordMatches(key("G", { shiftKey: true }), g!, true)).toBe(false);
    expect(chordMatches(key("?", { shiftKey: true }), parseKeys("?")[0]!, true)).toBe(true);
  });

  test("formats chips per platform", () => {
    expect(formatKeys("mod+k", true)).toBe("⌘K");
    expect(formatKeys("mod+k", false)).toBe("Ctrl+K");
    expect(formatKeys("g r", true)).toBe("G R");
    expect(formatKeys("?", true)).toBe("?");
  });

  test("aria-keyshortcuts names the one key the platform actually uses", () => {
    expect(ariaKeyShortcuts("mod+k", true)).toBe("Meta+K");
    expect(ariaKeyShortcuts("mod+j", false)).toBe("Control+J");
    expect(ariaKeyShortcuts("mod+shift+p", false)).toBe("Control+Shift+P");
    expect(ariaKeyShortcuts("?", true)).toBe("?");
  });
});

describe("shortcut matching", () => {
  const shortcuts = [
    shortcut("palette", "mod+k", { allowInInputs: true }),
    shortcut("sheet", "?"),
    shortcut("go-runs", "g r"),
    shortcut("go-search", "g s"),
    shortcut("documented-only", "mod+b", { handler: undefined }),
    shortcut("disabled", "x", { when: () => false }),
  ];

  test("a two-key sequence goes pending on the first key and fires on the second", () => {
    const first = matchShortcut(key("g"), [], shortcuts, true, false);
    expect(first.kind).toBe("pending");
    const second = matchShortcut(key("s"), first.kind === "pending" ? first.pressed : [], shortcuts, true, false);
    expect(second.kind === "fire" && second.shortcut.id).toBe("go-search");
  });

  test("an unrelated key after a prefix falls back to a fresh match", () => {
    const result = matchShortcut(key("?", { shiftKey: true }), parseKeys("g"), shortcuts, true, false);
    expect(result.kind === "fire" && result.shortcut.id).toBe("sheet");
  });

  test("typing in a field only lets shortcuts that opt in through", () => {
    expect(matchShortcut(key("?"), [], shortcuts, true, true).kind).toBe("none");
    expect(matchShortcut(key("g"), [], shortcuts, true, true).kind).toBe("none");
    const palette = matchShortcut(key("k", { metaKey: true }), [], shortcuts, true, true);
    expect(palette.kind === "fire" && palette.shortcut.id).toBe("palette");
  });

  test("inside a pass-through dialog only shortcuts that opt in fire", () => {
    const withPane = [...shortcuts, shortcut("ask", "mod+j", { allowInInputs: true, allowInDialogs: true })];
    expect(matchShortcut(key("k", { metaKey: true }), [], withPane, true, false, true).kind).toBe("none");
    expect(matchShortcut(key("g"), [], withPane, true, false, true).kind).toBe("none");
    const ask = matchShortcut(key("j", { metaKey: true }), [], withPane, true, true, true);
    expect(ask.kind === "fire" && ask.shortcut.id).toBe("ask");
  });

  test("documented-only and disabled shortcuts never fire", () => {
    expect(matchShortcut(key("b", { metaKey: true }), [], shortcuts, true, false).kind).toBe("none");
    expect(matchShortcut(key("x"), [], shortcuts, true, false).kind).toBe("none");
  });
});

describe("registry", () => {
  test("registration returns a disposer and a re-registered id replaces the earlier entry", () => {
    const before = listCommands().length;
    const disposeFirst = registerCommands([command("test:a", "First")]);
    const disposeSecond = registerCommands([command("test:a", "Second")]);
    expect(listCommands().filter(entry => entry.id === "test:a").map(entry => entry.label)).toEqual(["Second"]);
    disposeFirst();
    expect(listCommands().some(entry => entry.id === "test:a")).toBe(true);
    disposeSecond();
    expect(listCommands()).toHaveLength(before);

    const disposeShortcut = registerShortcuts([shortcut("test:j", "j")]);
    expect(listShortcuts().some(entry => entry.id === "test:j")).toBe(true);
    disposeShortcut();
    expect(listShortcuts().some(entry => entry.id === "test:j")).toBe(false);
  });
});

describe("OTLP endpoint", () => {
  const fake = (status: number, body: unknown) => (async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;

  test("uses the port the local service reports, not the page's port", async () => {
    expect(await readOtlpEndpoint(fake(200, { ok: true, service: "runphantom", port: 6200 }))).toBe("http://127.0.0.1:6200/v1/traces");
  });

  test("refuses to guess when the health response is not Run Phantom's", async () => {
    for (const [status, body] of [[200, { ok: true, service: "other", port: 1 }], [500, { error: "down" }], [200, { service: "runphantom", port: "6200" }]] as const) {
      const failure = await readOtlpEndpoint(fake(status, body)).then(() => null, (error: unknown) => error);
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toBe("Could not read the local service port.");
    }
  });
});

describe("theme", () => {
  test("system follows the OS and explicit choices win", () => {
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
    expect(resolveTheme("light", true)).toBe("light");
    expect(resolveTheme("dark", false)).toBe("dark");
  });

  test("light stays the default and dark is an opt-in override block", () => {
    const css = readFileSync(new URL("../app/src/index.css", import.meta.url), "utf8");
    expect(css).toMatch(/html:not\(\[data-theme="dark"\]\)\s*\{\s*color-scheme: light;/);
    expect(css).toContain(':root[data-theme="dark"] {');
    const boot = readFileSync(new URL("../app/public/assets/theme-boot.js", import.meta.url), "utf8");
    expect(boot).toContain('"runphantom:theme"');
    expect(boot).toContain('preference === "dark"');
  });

  test("every light colour token the dark theme must cover has a dark value", () => {
    const css = readFileSync(new URL("../app/src/index.css", import.meta.url), "utf8");
    const dark = css.slice(css.indexOf(':root[data-theme="dark"] {'));
    for (const token of ["--rp-canvas-blue", "--rp-ink", "--rp-ink-muted", "--rp-ink-subtle", "--rp-line", "--rp-accent", "--rp-focus", "--rp-danger", "--rp-danger-soft", "--rp-success", "--rp-warning", "--rp-n0", "--rp-n1", "--rp-n2", "--rp-n4", "--sidebar-background", "--rp-json-view-string"]) {
      expect(dark, token).toContain(`${token}:`);
    }
  });
});

describe("navigation", () => {
  test("nav labels stay pinned and every item belongs to a known group", () => {
    expect(NAV_ITEMS.map(item => item.label)).toEqual(["Runs", "Search", "Saved", "Evaluations", "Review queues", "Prompts", "Verification", "Cost & usage"]);
    const groups = new Set(NAV_GROUPS.map(group => group.id));
    expect(NAV_ITEMS.every(item => groups.has(item.group))).toBe(true);
    expect(new Set(NAV_ITEMS.map(item => item.shortcut)).size).toBe(NAV_ITEMS.length);
  });

  test("section matching is prefix-safe and supports a root Home path", () => {
    expect(isNavPathActive("/runs/abc", "/runs")).toBe(true);
    expect(isNavPathActive("/runsx", "/runs")).toBe(false);
    expect(isNavPathActive("/runs", "/")).toBe(false);
    expect(isNavPathActive("/", "/")).toBe(true);
    expect(sectionLabel("/settings")).toBe("Settings");
    expect(sectionLabel("/costs")).toBe("Cost & usage");
    expect(sectionLabel("/nope")).toBe("Not found");
  });
});
