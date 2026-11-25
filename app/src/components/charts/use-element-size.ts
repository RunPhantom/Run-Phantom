import { useLayoutEffect, useRef, useState } from "react";

export interface ElementSize { width: number; height: number }

/** Content-box size of the referenced element, kept current with a ResizeObserver. */
export function useElementSize<T extends HTMLElement>(): [React.RefObject<T | null>, ElementSize] {
  const ref = useRef<T | null>(null);
  const [size, setSize] = useState<ElementSize>({ width: 0, height: 0 });
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const update = (width: number, height: number) => {
      setSize(previous => previous.width === width && previous.height === height ? previous : { width, height });
    };
    const rect = element.getBoundingClientRect();
    update(Math.floor(rect.width), Math.floor(rect.height));
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(entries => {
      const box = entries[0]?.contentRect;
      if (box) update(Math.floor(box.width), Math.floor(box.height));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return [ref, size];
}
