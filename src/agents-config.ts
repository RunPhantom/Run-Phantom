import fs from "fs";
import path from "path";
import os from "os";
import { spawn } from "child_process";

const STATE_DIR = path.join(os.homedir(), ".runphantom");
const AGENTS_CONFIG_PATH = path.join(STATE_DIR, "agents.json");
const REPLAY_PROJECTS_PATH = path.join(STATE_DIR, "replay-projects.json");
const DAEMON_PORT_PATH = path.join(STATE_DIR, "runphantom.port");
const DEFAULT_DAEMON_PORT = 5947;
const REPLAY_PORT_START = 61020;
const REPLAY_PORT_END = 61044;
const MAX_HEALTH_RESPONSE_BYTES = 64 * 1024;
const MAX_COMMAND_LENGTH = 8 * 1024;

export interface AgentConfig {
  eventName?: string;
  url?: string;
  cwd?: string;
  command?: string;
  configPath?: string;
  lastSeenPort?: number;
  input?: Record<string, string>;
  prefillFromTrace?: Record<string, string>;
  models?: string[];
}

export type AgentsConfig = Record<string, AgentConfig>;

export interface EnsureAgentEndpointResult {
  eventName: string;
  config: AgentConfig | null;
  registered: boolean;
  attemptedStart: boolean;
  command?: string;
  cwd?: string;
  logPath?: string;
  reason?: "not_registered" | "start_timeout";
}

interface ReplayProjectRegistryEntry {
  configPath: string;
  agents: Record<string, {
    cwd: string;
    command: string;
    lastSeenPort?: number;
    input?: Record<string, string>;
    prefillFromTrace?: Record<string, string>;
    models?: string[];
  }>;
}

type ReplayProjectsRegistry = Record<string, ReplayProjectRegistryEntry>;

interface ReplayHealthResponse {
  ok?: boolean;
  eventName?: string;
  cwd?: string;
  command?: string;
  input?: unknown;
  prefillFromTrace?: unknown;
  models?: unknown;
}

interface ParsedAgentConfig {
  cwd?: string;
  command?: string;
  input?: Record<string, string>;
  prefillFromTrace?: Record<string, string>;
  models?: string[];
}

interface RegisterReplayProjectOptions {
  validate?: boolean;
  startupTimeoutMs?: number;
}

function isValidPort(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 65_535;
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return normalized === "localhost" || normalized === "127.0.0.1"
    || normalized === "::1" || normalized === "[::1]";
}

function normalizeLoopbackHttpUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 4_096) return null;
  const candidate = value.trim();
  if (candidate.includes("#")) return null;
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  if (!isLoopbackHostname(parsed.hostname)) return null;
  if (parsed.username || parsed.password || parsed.hash) return null;
  return parsed.toString();
}

function effectivePort(url: URL): number | null {
  if (url.port) {
    const port = Number(url.port);
    return isValidPort(port) ? port : null;
  }
  return url.protocol === "https:" ? 443 : url.protocol === "http:" ? 80 : null;
}

function replayUrlForHealthUrl(healthUrl: string): string | null {
  const normalized = normalizeLoopbackHttpUrl(healthUrl);
  if (!normalized) return null;
  const url = new URL(normalized);
  url.pathname = "/replay";
  url.search = "";
  return url.toString();
}

interface ParsedCommandLine {
  executable: string;
  args: string[];
}

function parseReplayCommand(command: string): ParsedCommandLine {
  if (!command.trim()) throw new Error("command is empty");
  if (command.length > MAX_COMMAND_LENGTH) throw new Error("command is too long");
  if (/[\r\n\0]/.test(command)) throw new Error("command contains a forbidden control character");

  const tokens: string[] = [];
  let token = "";
  let tokenStarted = false;
  let quote: "'" | '"' | null = null;

  const finishToken = () => {
    if (!tokenStarted) return;
    tokens.push(token);
    token = "";
    tokenStarted = false;
  };

  for (let i = 0; i < command.length; i++) {
    const char = command[i];
    const next = command[i + 1];

    if (quote) {
      if (char === quote) {
        quote = null;
        continue;
      }
      if (char === "`" || (char === "$" && (next === "(" || next === "{"))) {
        throw new Error("command substitution is not allowed");
      }
      if (char === "\\" && quote === '"' && next !== undefined && /[\\"\s]/.test(next)) {
        token += next;
        tokenStarted = true;
        i++;
        continue;
      }
      token += char;
      tokenStarted = true;
      continue;
    }

    if (/\s/.test(char)) {
      finishToken();
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      tokenStarted = true;
      continue;
    }
    if (char === "`" || (char === "$" && (next === "(" || next === "{"))) {
      throw new Error("command substitution is not allowed");
    }
    if (/[|&;<>]/.test(char) || char === "(" || char === ")") {
      throw new Error(`shell operator '${char}' is not allowed`);
    }
    if (char === "\\" && next !== undefined && /[\\'"\s|&;<>()]/.test(next)) {
      token += next;
      tokenStarted = true;
      i++;
      continue;
    }
    token += char;
    tokenStarted = true;
  }

  if (quote) throw new Error("command contains an unterminated quote");
  finishToken();
  if (!tokens.length || !tokens[0]) throw new Error("command is empty");
  return { executable: tokens[0], args: tokens.slice(1) };
}

function normalizeExporterUrl(value: unknown): string | null {
  const normalized = normalizeLoopbackHttpUrl(value);
  if (!normalized) return null;
  const url = new URL(normalized);
  url.pathname = "/v1/";
  url.search = "";
  return url.toString();
}

function readDaemonPort(file: string): number | null {
  try {
    const raw = fs.readFileSync(file, "utf8").trim();
    const port = Number(raw);
    return String(port) === raw && isValidPort(port) ? port : null;
  } catch {
    return null;
  }
}

// The port this daemon is actually listening on, published by the server once it
// binds. The port FILE can name a different daemon — a second instance that fell
// back to another port, or a leftover file — and the spawned replay agent then
// exported its trace to that other daemon, so the replay this process was waiting
// for never arrived and timed out with no explanation.
let activeDaemonPort: number | null = null;

export function setActiveDaemonPort(port: number | null): void {
  activeDaemonPort = port && Number.isInteger(port) && port > 0 ? port : null;
}

function resolveReplayTraceExporterUrl(
  env: NodeJS.ProcessEnv = process.env,
  portFile: string = DAEMON_PORT_PATH,
): string {
  const explicit = normalizeExporterUrl(env.RUNPHANTOM_LOCAL_DEBUGGER);
  if (explicit) return explicit;
  const daemonUrl = normalizeExporterUrl(env.RUNPHANTOM_URL);
  if (daemonUrl) return daemonUrl;
  // This process before any file on disk: it is the one awaiting the trace.
  if (activeDaemonPort) return `http://localhost:${activeDaemonPort}/v1/`;
  const port = readDaemonPort(portFile) ?? DEFAULT_DAEMON_PORT;
  return `http://localhost:${port}/v1/`;
}

export const _replayExporterInternal = { resolveReplayTraceExporterUrl };

function readJsonFile<T>(file: string, fallback: T): T {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}

export function loadAgentsConfig(): AgentsConfig {
  const merged: AgentsConfig = {};

  Object.assign(merged, sanitizeAgentsConfig(readJsonFile<AgentsConfig>(AGENTS_CONFIG_PATH, {})));

  const projects = loadReplayProjectsRegistry();
  for (const [cwd, project] of Object.entries(projects)) {
    for (const [eventName, agent] of Object.entries(project.agents ?? {})) {
      const port = isValidPort(agent.lastSeenPort) ? agent.lastSeenPort : undefined;
      merged[eventName] = {
        ...merged[eventName],
        cwd: agent.cwd || cwd,
        command: agent.command,
        configPath: project.configPath,
        lastSeenPort: port,
        url: port ? `http://127.0.0.1:${port}/replay` : merged[eventName]?.url,
        input: agent.input,
        prefillFromTrace: agent.prefillFromTrace,
        models: agent.models,
      };
    }
  }

  return merged;
}

function stringMap(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(value).slice(0, 100)) {
    if (key.length <= 256 && typeof item === "string" && item.length <= 10_000) out[key] = item;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function stringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out = value
    .filter((item): item is string => typeof item === "string" && item.length <= 256)
    .slice(0, 100);
  return out.length > 0 ? out : undefined;
}

export function sanitizeAgentsConfig(config: unknown): AgentsConfig {
  if (!config || typeof config !== "object" || Array.isArray(config)) return {};
  const sanitized: AgentsConfig = {};
  for (const [eventName, raw] of Object.entries(config)) {
    if (!eventName || !raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const entry = raw as Record<string, unknown>;
    const agent: AgentConfig = {};
    const url = normalizeLoopbackHttpUrl(entry.url);
    if (url) agent.url = url;
    const input = stringMap(entry.input);
    if (input) agent.input = input;
    const prefillFromTrace = stringMap(entry.prefillFromTrace);
    if (prefillFromTrace) agent.prefillFromTrace = prefillFromTrace;
    const models = stringList(entry.models);
    if (models) agent.models = models;
    if (Object.keys(agent).length > 0) sanitized[eventName] = agent;
  }
  return sanitized;
}

export function saveAgentsConfig(config: AgentsConfig): AgentsConfig {
  const sanitized = sanitizeAgentsConfig(config);
  fs.mkdirSync(path.dirname(AGENTS_CONFIG_PATH), { recursive: true });
  fs.writeFileSync(AGENTS_CONFIG_PATH, JSON.stringify(sanitized, null, 2));
  return sanitized;
}

export function loadReplayProjectsRegistry(): ReplayProjectsRegistry {
  return readJsonFile<ReplayProjectsRegistry>(REPLAY_PROJECTS_PATH, {});
}

function saveReplayProjectsRegistry(registry: ReplayProjectsRegistry): void {
  fs.mkdirSync(path.dirname(REPLAY_PROJECTS_PATH), { recursive: true });
  fs.writeFileSync(REPLAY_PROJECTS_PATH, JSON.stringify(registry, null, 2) + "\n");
}

function stripYamlComment(line: string): string {
  // `#` only starts a YAML comment after whitespace; `foo#bar` stays whole.
  const match = line.match(/(?:^|\s)#/);
  return match ? line.slice(0, match.index) : line;
}

function splitYamlPair(line: string): [string, string] | null {
  const idx = line.indexOf(":");
  if (idx < 0) return null;
  return [line.slice(0, idx).trim(), line.slice(idx + 1).trim()];
}

function parseSimpleAgentsYaml(text: string): Record<string, ParsedAgentConfig> {
  const agents: Record<string, any> = {};
  let currentAgent: string | null = null;
  let section: "input" | "prefillFromTrace" | "models" | null = null;

  for (const rawLine of text.split(/\r?\n/)) {
    const withoutComment = stripYamlComment(rawLine);
    if (!withoutComment.trim()) continue;
    const indent = withoutComment.match(/^ */)?.[0].length ?? 0;
    const line = withoutComment.trim();

    if (indent === 0) {
      const pair = splitYamlPair(line);
      if (!pair) continue;
      currentAgent = pair[0];
      section = null;
      agents[currentAgent] = agents[currentAgent] ?? {};
      continue;
    }

    if (!currentAgent) continue;

    if (indent === 2) {
      const pair = splitYamlPair(line);
      if (!pair) continue;
      const [key, value] = pair;
      if (key === "input" || key === "prefillFromTrace" || key === "models") {
        section = key;
        agents[currentAgent][key] = key === "models" ? [] : {};
      } else {
        section = null;
        if (value) agents[currentAgent][key] = value.replace(/^["']|["']$/g, "");
      }
      continue;
    }

    if (indent >= 4 && section) {
      if (section === "models") {
        if (line.startsWith("- ")) agents[currentAgent].models.push(line.slice(2).trim().replace(/^["']|["']$/g, ""));
      } else {
        const pair = splitYamlPair(line);
        if (pair) agents[currentAgent][section][pair[0]] = pair[1].replace(/^["']|["']$/g, "");
      }
    }
  }

  return agents;
}

export function getAgentsYamlPath(cwd: string): string {
  return path.join(cwd, ".runphantom", "agents.yaml");
}

function resolveAgentCwd(projectCwd: string, agentCwd: string | undefined): string {
  if (!agentCwd) return projectCwd;
  return path.resolve(projectCwd, agentCwd);
}

function samePath(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  return path.resolve(a) === path.resolve(b);
}

function healthMatchesAgent(eventName: string, expected: AgentConfig, actual: AgentConfig | null): actual is AgentConfig {
  if (!actual?.url) return false;
  if (actual.eventName && normalizeEventName(actual.eventName) !== normalizeEventName(eventName)) return false;
  if (expected.cwd) return samePath(expected.cwd, actual.cwd);
  const expectedUrl = normalizeLoopbackHttpUrl(expected.url);
  const actualUrl = normalizeLoopbackHttpUrl(actual.url);
  return expectedUrl !== null && expectedUrl === actualUrl;
}

function findRegisteredProjectForEvent(registry: ReplayProjectsRegistry, eventName: string): [string, ReplayProjectRegistryEntry] | null {
  const normalized = normalizeEventName(eventName);
  for (const [projectCwd, project] of Object.entries(registry)) {
    if (project.agents?.[normalized]) return [projectCwd, project];
  }
  return null;
}

async function findHealthyAgent(eventName: string, expected: AgentConfig): Promise<AgentConfig | null> {
  const healthy = await isAgentHealthy(expected);
  if (healthMatchesAgent(eventName, expected, healthy)) {
    const merged = { ...expected, ...healthy };
    updateRegistryFromHealth(eventName, merged);
    return merged;
  }

  const discovered = await discoverReplayAgents();
  const discoveredAgent = discovered[normalizeEventName(eventName)];
  if (healthMatchesAgent(eventName, expected, discoveredAgent)) {
    const merged = { ...expected, ...discoveredAgent };
    updateRegistryFromHealth(eventName, merged);
    return merged;
  }

  return null;
}

async function validateReplayAgentStartup(
  eventName: string,
  config: AgentConfig,
  timeoutMs: number,
): Promise<{ config: AgentConfig; attemptedStart: boolean; logPath?: string }> {
  const alreadyHealthy = await findHealthyAgent(eventName, config);
  if (alreadyHealthy) return { config: alreadyHealthy, attemptedStart: false, logPath: replayLogPath(config) ?? undefined };

  const logPath = spawnReplayCommand(config) ?? replayLogPath(config) ?? undefined;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 300));
    const healthy = await findHealthyAgent(eventName, config);
    if (healthy) return { config: healthy, attemptedStart: true, logPath };
  }

  throw new Error(
    `Agent "${eventName}" in ${config.configPath ?? "agents.yaml"} did not become healthy within ${Math.round(timeoutMs / 1000)}s.\n` +
      `  command: ${config.command}\n` +
      `  cwd: ${config.cwd}\n` +
      (logPath ? `  log: ${logPath}\n` : "") +
      `Fix the command/cwd, then run \`runphantom replay register\` again.`,
  );
}

export async function registerReplayProject(
  cwd = process.cwd(),
  opts: RegisterReplayProjectOptions = {},
): Promise<{ cwd: string; configPath: string; agents: string[] }> {
  const resolvedCwd = path.resolve(cwd);
  const configPath = getAgentsYamlPath(resolvedCwd);
  if (!fs.existsSync(configPath)) {
    throw new Error(`No .runphantom/agents.yaml found in ${resolvedCwd}`);
  }
  const parsed = parseSimpleAgentsYaml(fs.readFileSync(configPath, "utf8"));
  const registry = loadReplayProjectsRegistry();
  const existingProject = registry[resolvedCwd];
  const agentEntries: ReplayProjectRegistryEntry["agents"] = {};
  for (const [eventName, config] of Object.entries(parsed)) {
    if (!config.command) {
      throw new Error(`Agent "${eventName}" in ${configPath} is missing command`);
    }
    try {
      parseReplayCommand(config.command);
    } catch (err) {
      throw new Error(
        `Agent "${eventName}" in ${configPath} has an unsafe command: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const agentCwd = resolveAgentCwd(resolvedCwd, config.cwd);
    const existingAgent = existingProject?.agents?.[eventName];
    let entry: ReplayProjectRegistryEntry["agents"][string] = {
      cwd: agentCwd,
      command: config.command,
      lastSeenPort: samePath(existingAgent?.cwd, agentCwd) ? existingAgent?.lastSeenPort : undefined,
      input: config.input ?? {},
      prefillFromTrace: config.prefillFromTrace ?? {},
      models: config.models,
    };

    if (opts.validate !== false) {
      const validated = await validateReplayAgentStartup(
        eventName,
        {
          eventName,
          ...entry,
          configPath,
        },
        opts.startupTimeoutMs ?? 10_000,
      );
      entry = {
        ...entry,
        cwd: validated.config.cwd ?? agentCwd,
        command: validated.config.command ?? entry.command,
        lastSeenPort: validated.config.lastSeenPort ?? entry.lastSeenPort,
      };
    }

    agentEntries[eventName] = {
      ...entry,
    };
  }
  registry[resolvedCwd] = { configPath, agents: agentEntries };
  saveReplayProjectsRegistry(registry);
  return { cwd: resolvedCwd, configPath, agents: Object.keys(agentEntries) };
}

export async function registerReplayProjectIfPresent(cwd: string): Promise<boolean> {
  try {
    const configPath = getAgentsYamlPath(path.resolve(cwd));
    if (!fs.existsSync(configPath)) return false;
    await registerReplayProject(cwd, { validate: false });
    return true;
  } catch {
    return false;
  }
}

export function getAgentEndpoint(eventName: string): AgentConfig | null {
  const config = loadAgentsConfig();
  return config[eventName] ?? null;
}

function normalizeEventName(name: string): string {
  return name.replace(/^replay:/, "");
}

async function readBoundedJsonObject(res: Response): Promise<Record<string, unknown> | null> {
  const declaredLength = Number(res.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_HEALTH_RESPONSE_BYTES) return null;
  if (!res.body) return null;

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_HEALTH_RESPONSE_BYTES) {
      await reader.cancel();
      return null;
    }
    text += decoder.decode(value, { stream: true });
  }
  text += decoder.decode();
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function boundedString(value: unknown, maxLength: number): string | undefined {
  return typeof value === "string" && value.length <= maxLength && !/[\r\n\0]/.test(value)
    ? value
    : undefined;
}

async function probeReplayHealth(target: number | string): Promise<AgentConfig | null> {
  const replayUrl = typeof target === "number"
    ? isValidPort(target) ? `http://127.0.0.1:${target}/replay` : null
    : normalizeLoopbackHttpUrl(target);
  if (!replayUrl) return null;
  const parsedReplayUrl = new URL(replayUrl);
  const port = effectivePort(parsedReplayUrl);
  if (!port) return null;
  const healthUrl = new URL(parsedReplayUrl);
  healthUrl.pathname = "/health";
  healthUrl.search = "";

  try {
    const res = await fetch(healthUrl, {
      signal: AbortSignal.timeout(600),
    });
    if (!res.ok) return null;
    const body = await readBoundedJsonObject(res) as ReplayHealthResponse | null;
    const rawEventName = boundedString(body?.eventName, 256);
    const rawCwd = boundedString(body?.cwd, 4_096);
    const command = boundedString(body?.command, MAX_COMMAND_LENGTH);
    if (
      body?.ok !== true ||
      !rawEventName ||
      !rawCwd ||
      !path.isAbsolute(rawCwd) ||
      !command ||
      !parseReplayCommand(command)
    ) return null;
    const eventName = normalizeEventName(rawEventName);
    if (!eventName) return null;
    const config: AgentConfig = {
      eventName,
      url: replayUrlForHealthUrl(healthUrl.toString()) ?? undefined,
      cwd: path.resolve(rawCwd),
      command,
      lastSeenPort: port,
      input: stringMap(body?.input),
      prefillFromTrace: stringMap(body?.prefillFromTrace),
      models: stringList(body?.models),
    };
    return config;
  } catch {
    return null;
  }
}

// Batched: one read-modify-write per call. Fan-out callers must pass every
// entry in a single call, not loop one-at-a-time, to avoid racing writes.
function applyHealthDiscoveries(entries: Array<[string, AgentConfig]>): void {
  const usable = entries.filter(([, c]) => c.cwd && c.command);
  if (usable.length === 0) return;
  const registry = loadReplayProjectsRegistry();
  for (const [eventName, config] of usable) {
    const cwd = path.resolve(config.cwd!);
    const existingRegisteredProject = findRegisteredProjectForEvent(registry, eventName);
    const projectCwd = existingRegisteredProject?.[0] ?? cwd;
    const existing = existingRegisteredProject?.[1] ?? registry[projectCwd] ?? { configPath: getAgentsYamlPath(projectCwd), agents: {} };
    existing.agents[eventName] = {
      cwd,
      command: config.command!,
      lastSeenPort: config.lastSeenPort,
      input: config.input,
      prefillFromTrace: config.prefillFromTrace,
      models: config.models,
    };
    registry[projectCwd] = existing;
  }
  saveReplayProjectsRegistry(registry);
}

function updateRegistryFromHealth(eventName: string, config: AgentConfig): void {
  applyHealthDiscoveries([[eventName, config]]);
}

export async function discoverReplayAgents(): Promise<AgentsConfig> {
  const discovered: AgentsConfig = {};
  await Promise.all(
    Array.from({ length: REPLAY_PORT_END - REPLAY_PORT_START + 1 }, async (_, i) => {
      const port = REPLAY_PORT_START + i;
      const config = await probeReplayHealth(port);
      if (config?.eventName && config.url) discovered[config.eventName] = config;
    }),
  );
  applyHealthDiscoveries(Object.entries(discovered));
  return discovered;
}

async function isAgentHealthy(config: AgentConfig): Promise<AgentConfig | null> {
  const replayUrl = normalizeLoopbackHttpUrl(config.url);
  const port = isValidPort(config.lastSeenPort) ? config.lastSeenPort : null;
  if (!replayUrl && !port) return null;
  return probeReplayHealth(replayUrl ?? port!);
}

function replayLogPath(config: AgentConfig): string | null {
  if (!config.cwd) return null;
  return path.join(STATE_DIR, `replay-${path.basename(config.cwd)}.log`);
}

function spawnReplayCommand(config: AgentConfig): string | null {
  if (!config.cwd || !config.command) return null;
  const parsed = parseReplayCommand(config.command);
  const logPath = path.join(STATE_DIR, `replay-${path.basename(config.cwd)}.log`);
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const out = fs.openSync(logPath, "a");
  let child;
  try {
    child = spawn(parsed.executable, parsed.args, {
      cwd: config.cwd,
      shell: false,
      detached: true,
      stdio: ["ignore", out, out],
      env: {
        ...process.env,
        RUNPHANTOM_LOCAL_DEBUGGER: resolveReplayTraceExporterUrl(),
      },
    });
  } catch (err) {
    fs.closeSync(out);
    throw err;
  }
  // spawn() reports a missing executable ASYNCHRONOUSLY via an 'error' event, not
  // by throwing — so the try/catch above never sees ENOENT. Without a listener
  // that event is unhandled and takes the whole daemon down with it, meaning a
  // replay against an agent whose binary has moved kills the user's session.
  child.on("error", (err) => {
    const detail = `[runphantom] replay agent failed to start: ${(err as Error).message}\n`;
    try {
      fs.appendFileSync(logPath, detail);
    } catch {
      /* the log is best-effort; never let logging escalate into a crash */
    }
    console.error(detail.trim());
  });
  child.unref();
  fs.closeSync(out);
  return logPath;
}

export async function ensureAgentEndpointDetailed(eventName: string): Promise<EnsureAgentEndpointResult> {
  const name = normalizeEventName(eventName);
  let config = getAgentEndpoint(name);
  if (config) {
    const healthy = await findHealthyAgent(name, config);
    if (healthy?.url) {
      return {
        eventName: name,
        config: { ...config, ...healthy },
        registered: true,
        attemptedStart: false,
        command: config.command,
        cwd: config.cwd,
        logPath: replayLogPath(config) ?? undefined,
      };
    }
  }

  const discovered = await discoverReplayAgents();
  if (discovered[name]?.url) {
    return {
      eventName: name,
      config: discovered[name],
      registered: true,
      attemptedStart: false,
      command: discovered[name].command,
      cwd: discovered[name].cwd,
      logPath: replayLogPath(discovered[name]) ?? undefined,
    };
  }

  config = getAgentEndpoint(name);
  if (!config?.command || !config.cwd) {
    return {
      eventName: name,
      config: null,
      registered: false,
      attemptedStart: false,
      reason: "not_registered",
    };
  }
  const logPath = spawnReplayCommand(config) ?? replayLogPath(config) ?? undefined;

  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 300));
    const healthy = await findHealthyAgent(name, config);
    if (healthy?.url) {
      return {
        eventName: name,
        config: { ...config, ...healthy },
        registered: true,
        attemptedStart: true,
        command: config.command,
        cwd: config.cwd,
        logPath,
      };
    }
    const rescanned = await discoverReplayAgents();
    if (rescanned[name]?.url) {
      return {
        eventName: name,
        config: rescanned[name],
        registered: true,
        attemptedStart: true,
        command: config.command,
        cwd: config.cwd,
        logPath,
      };
    }
  }

  return {
    eventName: name,
    config: null,
    registered: true,
    attemptedStart: true,
    command: config.command,
    cwd: config.cwd,
    logPath,
    reason: "start_timeout",
  };
}

export async function ensureAgentEndpoint(eventName: string): Promise<AgentConfig | null> {
  return (await ensureAgentEndpointDetailed(eventName)).config;
}

export const _internal = {
  parseSimpleAgentsYaml,
  parseReplayCommand,
  resolveAgentCwd,
  resolveReplayTraceExporterUrl,
  normalizeLoopbackHttpUrl,
  probeReplayHealth,
  healthMatchesAgent,
};

export function extractContextFromTrace(
  spans: any[],
  contextMapping: Record<string, string>,
): Record<string, any> {
  const allAttrs: Record<string, any> = {};
  for (const span of spans) {
    if (!span.attributes) continue;
    try {
      const attrs = typeof span.attributes === "string" ? JSON.parse(span.attributes) : span.attributes;
      for (const [k, v] of Object.entries(attrs)) {
        if (!allAttrs[k]) allAttrs[k] = v;
      }
    } catch {}
  }

  const propsStr = allAttrs["ai.telemetry.metadata.runphantom.properties"];
  let props: Record<string, any> = {};
  if (propsStr) {
    try { props = typeof propsStr === "string" ? JSON.parse(propsStr) : propsStr; } catch {}
  }

  const context: Record<string, any> = {};
  for (const [field, attrPath] of Object.entries(contextMapping)) {
    if (allAttrs[attrPath] !== undefined) {
      context[field] = allAttrs[attrPath];
      continue;
    }
    if (attrPath.startsWith("properties.")) {
      const propKey = attrPath.slice("properties.".length);
      if (props[propKey] !== undefined) {
        context[field] = props[propKey];
        continue;
      }
    }
    const runPhantomPrefix = "ai.telemetry.metadata.runphantom.properties.";
    if (attrPath.startsWith(runPhantomPrefix)) {
      const propKey = attrPath.slice(runPhantomPrefix.length);
      if (props[propKey] !== undefined) {
        context[field] = props[propKey];
        continue;
      }
    }
    const metaPrefix = "ai.telemetry.metadata.runphantom.";
    if (attrPath.startsWith(metaPrefix)) {
      const metaKey = metaPrefix + attrPath.slice(metaPrefix.length);
      if (allAttrs[metaKey] !== undefined) {
        context[field] = allAttrs[metaKey];
        continue;
      }
    }
    if (props[attrPath] !== undefined) {
      context[field] = props[attrPath];
    }
  }

  return context;
}
