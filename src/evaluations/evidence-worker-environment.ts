export const EVIDENCE_WORKER_FAILURE = '{"version":1,"id":null,"error":"protocol_invalid"}';
export const WINDOWS_WORKER_BOOTSTRAP_KEYS = ["HOMEDRIVE", "HOMEPATH", "LOGONSERVER", "PATH", "SYSTEMDRIVE", "TEMP", "USERDOMAIN", "USERNAME", "USERPROFILE", "WINDIR"] as const;
const CACHE_KEY = "BUN_RUNTIME_TRANSPILER_CACHE_PATH";
const OPERATIONAL_KEYS = ["LANG", "TZ", "SYSTEMROOT"];

/** Empty sentinels prevent libuv from copying missing Windows defaults from the parent. */
export function evidenceWorkerLaunchEnv(platform: NodeJS.Platform = process.platform, systemRoot: string | undefined = process.env.SystemRoot): Record<string, string> {
  const env: Record<string, string> = { LANG: "C.UTF-8", TZ: "UTC", [CACHE_KEY]: "0" };
  if (platform === "win32") {
    for (const key of WINDOWS_WORKER_BOOTSTRAP_KEYS) env[key] = "";
    if (systemRoot) env.SystemRoot = systemRoot;
  }
  return env;
}

function checkedRemovals(env: NodeJS.ProcessEnv, platform: NodeJS.Platform, bootstrap: boolean): string[] | null {
  const removals: string[] = [];
  for (const key of Object.keys(env)) {
    const upper = key.toUpperCase();
    if (OPERATIONAL_KEYS.includes(upper)) continue;
    const cache = (platform === "win32" ? upper : key) === CACHE_KEY;
    const sentinel = bootstrap && platform === "win32" && WINDOWS_WORKER_BOOTSTRAP_KEYS.some(known => known === upper);
    if (!cache && !sentinel) return null;
    const descriptor = Object.getOwnPropertyDescriptor(env, key);
    if (!descriptor || !("value" in descriptor) || !descriptor.configurable || descriptor.value !== (cache ? "0" : "")) return null;
    if (!cache || !bootstrap) removals.push(key);
  }
  return removals;
}

/** Validate the entire environment before removing any bootstrap key; retain cache=0 through module loading. */
export function prepareEvidenceWorkerEnvironment(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): boolean {
  const removals = checkedRemovals(env, platform, true);
  if (!removals) return false;
  for (const key of removals) delete env[key];
  return true;
}

/** Module loading has finished. Only the three operational keys may remain before stdin is read. */
export function finishEvidenceWorkerEnvironment(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): boolean {
  const removals = checkedRemovals(env, platform, false);
  if (!removals) return false;
  for (const key of removals) delete env[key];
  return true;
}
