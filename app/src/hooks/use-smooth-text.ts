import { useEffect, useRef, useState } from "react";
import { usePrefersReducedMotion } from "./use-prefers-reduced-motion";

export function useSmoothText(
  text: string,
  enabled: boolean,
  charsPerFrame: number = 3,
): string {
  const prefersReducedMotion = usePrefersReducedMotion();
  const shouldAnimate = enabled && !prefersReducedMotion;
  const [displayed, setDisplayed] = useState(text);
  const targetRef = useRef(text);
  const posRef = useRef(text.length);
  const rafRef = useRef<number>(0);

  useEffect(() => {
    targetRef.current = text;
    cancelAnimationFrame(rafRef.current);
    rafRef.current = 0;

    if (!shouldAnimate) {
      setDisplayed(text);
      posRef.current = text.length;
      return undefined;
    }

    if (posRef.current > text.length) {
      posRef.current = 0;
      setDisplayed("");
    }

    if (posRef.current >= text.length) {
      setDisplayed(text);
      return undefined;
    }

    const tick = () => {
      const target = targetRef.current;
      if (posRef.current < target.length) {
        const behind = target.length - posRef.current;
        const speed = behind > 100 ? Math.ceil(behind / 10) : charsPerFrame;
        posRef.current = Math.min(posRef.current + speed, target.length);
        setDisplayed(target.slice(0, posRef.current));
      }
      rafRef.current = posRef.current < target.length ? requestAnimationFrame(tick) : 0;
    };

    rafRef.current = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = 0;
    };
  }, [charsPerFrame, shouldAnimate, text]);

  return shouldAnimate ? displayed : text;
}
