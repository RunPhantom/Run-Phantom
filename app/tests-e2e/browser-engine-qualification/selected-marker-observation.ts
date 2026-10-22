import { VERIFICATION_LIMITS } from "../../../src/verification/protocol";
import type { BrowserObservation } from "../../../src/verification/browser-types";

// A check may read immediately, then poll until the existing check deadline.
export const MAX_SELECTED_MARKER_SAMPLES = 1 + Math.ceil(VERIFICATION_LIMITS.CHECK_TIMEOUT_MS / VERIFICATION_LIMITS.POLL_MS);
export function selectedPhysicalIndex(observation: BrowserObservation, expected: { id: string; generation: number; origin: string }): 0 | 1 {
  const session = observation.session;
  if (session.id !== expected.id || session.generation !== expected.generation || session.origin !== expected.origin
    || session.engine !== "chromium" || session.ownership !== "attached" || session.history !== "from-selection" || session.state !== "ready"
    || !session.coverage.dom || session.coverage.network || session.loss || !observation.complete || observation.dropped !== 0)
    throw new Error("Selected marker authority or coverage is unavailable");
  if (observation.events.some(event => event.truncated || event.type === "observer.error" || event.type === "capture.loss"))
    throw new Error("Selected marker capture contains unavailable records");
  const selectors = ["#physical0", "#physical1"];
  const dom = observation.events.filter(event => event.type === "dom");
  if (dom.some(event => !selectors.includes(String(event.data.selector)))) throw new Error("Unexpected selected marker selector");
  const counts = selectors.map(selector => {
    const samples = dom.filter(event => event.data.selector === selector);
    if (samples.length === 0 || samples.length > MAX_SELECTED_MARKER_SAMPLES) throw new Error("Selected marker samples are empty or exceed the check bound");
    const count = samples[0].data.count;
    if (count !== 0 && count !== 1) throw new Error("Selected marker count is ambiguous or unavailable");
    if (!samples.every((event, index) => event.data.count === count && Number.isFinite(event.t) && (index === 0 || event.t >= samples[index - 1].t)))
      throw new Error("Selected marker samples drift or are unavailable");
    return count;
  });
  if (counts[0] === counts[1]) throw new Error("Selected physical identity is not unique");
  return counts[0] === 1 ? 0 : 1;
}
