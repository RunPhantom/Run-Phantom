// Motion is latency when the user is driving from the keyboard. Someone holding
// j/k down the run list is issuing a command, not requesting an animation, and a
// 110ms tint on every step turns a fast scan into a smear. Pointer users get the
// motion; keyboard users get the frame.
const NAV_KEYS = new Set([
  "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight",
  "j", "k", "n", "p", "Home", "End", "PageUp", "PageDown", "Enter", "Escape",
]);

export function installNavModality(): () => void {
  const root = document.documentElement;
  const onKey = (e: KeyboardEvent) => {
    if (NAV_KEYS.has(e.key) || e.metaKey || e.ctrlKey) root.dataset.nav = "key";
  };
  const onPointer = () => {
    if (root.dataset.nav === "key") root.dataset.nav = "pointer";
  };
  window.addEventListener("keydown", onKey, { capture: true });
  window.addEventListener("pointerdown", onPointer, { capture: true });
  window.addEventListener("wheel", onPointer, { capture: true, passive: true });
  root.dataset.nav = "pointer";
  return () => {
    window.removeEventListener("keydown", onKey, { capture: true });
    window.removeEventListener("pointerdown", onPointer, { capture: true });
    window.removeEventListener("wheel", onPointer, { capture: true });
  };
}
