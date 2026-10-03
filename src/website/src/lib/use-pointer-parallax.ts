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
    let rect: DOMRect | null = null;
    let last = "";
    const set = (x: number, y: number) => {
      const next = `${x.toFixed(0)}/${y.toFixed(0)}`;
      if (next === last) return;
      last = next;
      el.style.setProperty("--px", `${x.toFixed(0)}px`);
      el.style.setProperty("--py", `${y.toFixed(0)}px`);
    };
    const enter = () => {
      rect = el.getBoundingClientRect();
    };
    const move = (e: PointerEvent) => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        rect ??= el.getBoundingClientRect();
        const nx = ((e.clientX - rect.left) / rect.width) * 2 - 1;
        const ny = ((e.clientY - rect.top) / rect.height) * 2 - 1;
        set(nx * MAX_X, ny * MAX_Y);
      });
    };
    const leave = () => {
      cancelAnimationFrame(frame);
      rect = null;
      set(0, 0);
    };
    el.addEventListener("pointerenter", enter);
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerleave", leave);
    return () => {
      cancelAnimationFrame(frame);
      el.removeEventListener("pointerenter", enter);
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerleave", leave);
    };
  }, []);
  return ref;
}
