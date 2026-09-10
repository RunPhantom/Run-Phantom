import { useEffect, type RefObject } from "react";
import { NavigationType, useLocation, useNavigationType } from "react-router-dom";

/**
 * Restores an inner scroll container's position when the user navigates Back.
 *
 * React Router's own ScrollRestoration only handles window scroll, and every
 * list in this app scrolls inside its own pane — so Back returned to the right
 * route with the list snapped to the top, losing the reader's place in a list
 * that can hold thousands of runs.
 *
 * Positions are keyed by history entry (`location.key`), not by path: two visits
 * to the same route are different entries and should not inherit each other's
 * offset. The store is module-level and dies with the tab, which matches the
 * lifetime of the history stack it describes.
 */
const positions = new Map<string, number>();

export function useScrollRestoration(ref: RefObject<HTMLElement | null>, id: string): void {
  const location = useLocation();
  const navigationType = useNavigationType();
  const key = `${location.key}:${id}`;

  useEffect(() => {
    const element = ref.current;
    if (!element) return;

    // Only a Back/Forward navigation should reposition the list. A fresh PUSH is
    // a new entry and belongs at the top.
    let raf = 0;
    if (navigationType === NavigationType.Pop) {
      const saved = positions.get(key);
      if (saved) {
        // The list is fetched asynchronously, so a single frame is not enough:
        // assigning scrollTop while the container is still empty clamps it to 0
        // and the restore silently does nothing. Retry until the content is tall
        // enough to hold the offset, then stop.
        const deadline = performance.now() + 2000;
        const attempt = () => {
          const element = ref.current;
          if (!element) return;
          if (element.scrollHeight - element.clientHeight >= saved) {
            element.scrollTop = saved;
            return;
          }
          if (performance.now() < deadline) raf = requestAnimationFrame(attempt);
        };
        raf = requestAnimationFrame(attempt);
      }
    }

    const onScroll = () => positions.set(key, element.scrollTop);
    element.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      if (raf) cancelAnimationFrame(raf);
      // Only record on the way out while the node is still in the document. React
      // can detach it before cleanup runs, and a detached element reports
      // scrollTop 0 — which overwrote the position this hook exists to keep.
      if (element.isConnected) positions.set(key, element.scrollTop);
      element.removeEventListener("scroll", onScroll);
    };
  }, [key, navigationType, ref]);
}
