/**
 * Route observer.
 *
 * Emits `route` only when the document's URL actually changed, covering both
 * `history` mutations and back/forward navigation. Nothing but the redacted URL is
 * recorded.
 *
 * Teardown restores each method only when the installed function is still the patch
 * this observer put there, so it cannot clobber a patch installed after it, and it
 * clears `active` first so a callback already queued cannot emit afterwards.
 */
import { captureMethod } from "../patching/capture-method.js";
import { redactUrl } from "../../redaction.js";
import { observeSafely, observerFailure, type Emit, type Teardown } from "./types.js";

export function installRoute(emit: Emit): Teardown {
  const origPush = captureMethod(history, "pushState");
  const origReplace = captureMethod(history, "replaceState");
  const callPush = origPush.bind(history);
  const callReplace = origReplace.bind(history);
  let active = true;
  let lastHref = location.href;
  const failure = observerFailure(emit, "route");
  const fire = (): void => observeSafely(() => {
    if (!active || location.href === lastHref) return;
    lastHref = location.href;
    emit("route", { url: redactUrl(lastHref) });
  }, failure);
  const patchedPush: History["pushState"] = (data, unused, url) => {
    callPush(data, unused, url);
    fire();
  };
  const patchedReplace: History["replaceState"] = (data, unused, url) => {
    callReplace(data, unused, url);
    fire();
  };
  const teardown = (): void => {
    active = false;
    if (history.pushState === patchedPush) history.pushState = origPush;
    if (history.replaceState === patchedReplace) history.replaceState = origReplace;
    window.removeEventListener("popstate", fire);
    window.removeEventListener("hashchange", fire);
  };
  try {
    history.pushState = patchedPush;
    history.replaceState = patchedReplace;
    window.addEventListener("popstate", fire);
    window.addEventListener("hashchange", fire);
  } catch (error) {
    observeSafely(teardown);
    throw error;
  }
  return teardown;
}
