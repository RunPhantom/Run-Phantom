/**
 * Console observer.
 *
 * Patches the five console levels and also listens for `error` and
 * `unhandledrejection`, emitting each as one bounded, sanitised message. An Error
 * contributes its `message` only — a stack carries absolute paths from the machine
 * that produced it and gives an assertion nothing extra to evaluate. Argument lists
 * are capped at 100 and the cap is reported, so a consumer can tell a short message
 * from a clipped one.
 */
import { captureMethod } from "../patching/capture-method.js";
import { sanitizeWithReport } from "../../serialization.js";
import { observeSafely, observerFailure, type Emit, type Teardown } from "./types.js";

type ConsoleMethod = "log" | "warn" | "error" | "info" | "debug";

type Sanitize = (value: unknown) => { value: unknown; truncated: boolean };
function stringifyArgs(args: unknown[], sanitize: Sanitize): { message: string; truncated: boolean } {
  let truncated = args.length > 100;
  const message = args.slice(0, 100).map((arg) => {
    const safe = sanitize(arg instanceof Error ? arg.message : arg);
    truncated ||= safe.truncated;
    return typeof safe.value === "string" ? safe.value : JSON.stringify(safe.value);
  }).join(" ");
  return { message, truncated };
}

export function installConsole(emit: Emit, sanitize: Sanitize = (value) => {
  const safe = sanitizeWithReport(value);
  return { value: safe.value, truncated: Boolean(safe.truncation || safe.redacted) };
}): Teardown {
  const methods: ConsoleMethod[] = ["log", "warn", "error", "info", "debug"];
  const originals = new Map<ConsoleMethod, (...args: unknown[]) => void>();
  const patched = new Map<ConsoleMethod, (...args: unknown[]) => void>();
  let active = true;
  const failure = observerFailure(emit, "console");
  const onError = (event: ErrorEvent): void => observeSafely(() => {
    if (active) emit("console", { level: "error", message: event.message });
  }, failure);
  const onRejection = (event: PromiseRejectionEvent): void => observeSafely(() => {
    const message = stringifyArgs([event.reason], sanitize);
    if (active) emit("console", { level: "error", message: message.message }, undefined, message.truncated);
  }, failure);
  const teardown = (): void => {
    active = false;
    for (const [method, original] of originals) {
      if (console[method] === patched.get(method)) console[method] = original;
    }
    window.removeEventListener("error", onError);
    window.removeEventListener("unhandledrejection", onRejection);
  };
  try {
    for (const method of methods) {
      const original = captureMethod(console, method);
      originals.set(method, original);
      const callOriginal = original.bind(console);
      const wrapper = (...args: unknown[]): void => {
        observeSafely(() => {
          if (active) {
            const message = stringifyArgs(args, sanitize);
            emit("console", { level: method, message: message.message }, undefined, message.truncated);
          }
        }, failure);
        callOriginal(...args);
      };
      patched.set(method, wrapper);
      console[method] = wrapper;
    }
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);
  } catch (error) {
    observeSafely(teardown);
    throw error;
  }
  return teardown;
}
