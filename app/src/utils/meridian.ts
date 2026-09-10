// The meridian: one rust marker meaning "this is where you are in the trace",
// lit simultaneously in every pane showing the same span — flame bar, span-tree
// row, and tool-call pill in the transcript.
//
// Deliberately not React state. This fires on pointermove across a 400-row span
// tree; routing it through a context would re-render every consumer on every
// hover. Two attribute writes per transition instead, scoped by an indexed
// attribute selector so the cost is O(matches), not O(spans).
let current: string | null = null;

function paint(key: string | null, on: boolean): void {
  if (!key) return;
  const sel = `[data-meridian-key="${CSS.escape(key)}"]`;
  for (const el of document.querySelectorAll(sel)) {
    if (on) el.setAttribute("data-meridian", "on");
    else el.removeAttribute("data-meridian");
  }
}

export function setMeridian(key: string | null): void {
  if (key === current) return;
  paint(current, false);
  current = key;
  paint(key, true);
}

export function clearMeridian(): void {
  setMeridian(null);
}
