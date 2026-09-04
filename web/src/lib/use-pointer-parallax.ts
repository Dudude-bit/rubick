import { useEffect, useRef } from "react";

const MAX_X = 10;
const MAX_Y = 8;

export function usePointerParallax<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const wanted = matchMedia(
      "(pointer: fine) and (prefers-reduced-motion: no-preference)"
    );
    if (!wanted.matches) return;

    let frame = 0;
    const set = (x: number, y: number) => {
      el.style.setProperty("--px", `${x.toFixed(1)}px`);
      el.style.setProperty("--py", `${y.toFixed(1)}px`);
    };
    const move = (e: PointerEvent) => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const r = el.getBoundingClientRect();
        const nx = ((e.clientX - r.left) / r.width) * 2 - 1;
        const ny = ((e.clientY - r.top) / r.height) * 2 - 1;
        set(nx * MAX_X, ny * MAX_Y);
      });
    };
    const leave = () => {
      cancelAnimationFrame(frame);
      set(0, 0);
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerleave", leave);
    return () => {
      cancelAnimationFrame(frame);
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerleave", leave);
    };
  }, []);
  return ref;
}
