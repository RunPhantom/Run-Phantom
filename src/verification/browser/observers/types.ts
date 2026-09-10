/**
 * The contract every observer implements.
 *
 * An observer emits typed events, reports its own truncation, and may tie an event to
 * the action that started it. What it must never do is change what the observed
 * application does: a failed observation emits `observer.error` and continues rather
 * than throwing into the page's own call stack.
 */
export type Emit = (type: string, data: Record<string, unknown>, actionId?: string | null, truncated?: boolean) => void;
export type Teardown = () => void;

/** Payload construction and transport must never escape into the observed application. */
export function observeSafely(observation: () => void, onError?: () => void): void {
  try {
    observation();
  } catch {
    try { onError?.(); } catch { /* An observer must not change application behavior. */ }
  }
}

export function observeValue<T>(read: () => T): T | undefined {
  try { return read(); } catch { return undefined; }
}

export function observerFailure(emit: Emit, observer: string): () => void {
  return () => emit("observer.error", { observer, message: "Observation could not be captured completely" });
}
