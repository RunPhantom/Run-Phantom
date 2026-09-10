import { useEffect, useRef } from "react";

const GRID = 22;

export function SignalField({
  px = 6,
  gap = 4,
  className,
}: {
  px?: number;
  gap?: number;
  className?: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const frameRef = useRef(0);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext("2d");
    if (!context) return;
    const ctx = context;

    const width = GRID * (px + gap) - gap;
    const height = width;
    const dpr = window.devicePixelRatio || 1;
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    let inViewport = true;

    canvas.width = width * dpr;
    canvas.height = height * dpr;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    canvas.style.maxWidth = "100%";
    canvas.style.objectFit = "contain";
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    function paint(time: number, animate: boolean) {
      const t = time * 0.001;
      ctx.clearRect(0, 0, width, height);

      for (let row = 0; row < GRID; row += 1) {
        for (let col = 0; col < GRID; col += 1) {
          const x = col * (px + gap);
          const y = row * (px + gap);
          const dx = col - GRID / 2;
          const dy = row - GRID / 2;
          const radius = Math.sqrt(dx * dx + dy * dy);
          const aperture = Math.max(0, 1 - radius / 13.5);
          const sweep = Math.sin(t * 1.8 + col * 0.45 - row * 0.18) * 0.14;
          const trace = Math.max(0, 1 - Math.abs(row - (col * 0.62 + 4 + Math.sin(t * 1.3) * 1.2)) / 1.8);
          const intensity = Math.max(0.08, aperture * 0.46 + sweep + trace * 0.48);
          const alpha = Math.min(0.92, Math.max(0.06, intensity));
          const color = trace > 0.55 ? "199,70,45" : "65,52,54";
          ctx.fillStyle = `rgba(${color},${alpha})`;
          ctx.fillRect(x, y, px, px);
        }
      }

      if (animate && inViewport && !document.hidden) {
        frameRef.current = window.requestAnimationFrame((nextTime) => paint(nextTime, true));
      }
    }

    function start() {
      window.cancelAnimationFrame(frameRef.current);
      if (reducedMotion.matches || !inViewport || document.hidden) {
        paint(0, false);
      } else {
        frameRef.current = window.requestAnimationFrame((time) => paint(time, true));
      }
    }

    const observer = new IntersectionObserver(([entry]) => {
      inViewport = entry?.isIntersecting ?? true;
      start();
    });

    start();
    observer.observe(canvas);
    reducedMotion.addEventListener("change", start);
    document.addEventListener("visibilitychange", start);
    return () => {
      observer.disconnect();
      reducedMotion.removeEventListener("change", start);
      document.removeEventListener("visibilitychange", start);
      window.cancelAnimationFrame(frameRef.current);
    };
  }, [gap, px]);

  return <canvas ref={canvasRef} className={className} aria-hidden="true" />;
}
