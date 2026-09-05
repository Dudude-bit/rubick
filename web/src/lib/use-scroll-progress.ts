import { useEffect, useRef } from "react";

// Sets --progress (0..1) on the element as it passes through the viewport,
// only while it is near the viewport, and latches at 1 for the visit.
export function useScrollProgress<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const wanted = matchMedia(
      "(min-width: 768px) and (prefers-reduced-motion: no-preference)"
    );
    if (!wanted.matches || !("IntersectionObserver" in window)) return;

    let frame = 0;
    let listening = false;
    let done = false;
    const stop = () => {
      if (!listening) return;
      listening = false;
      window.removeEventListener("scroll", schedule);
      cancelAnimationFrame(frame);
    };
    const compute = () => {
      const r = el.getBoundingClientRect();
      const vh = window.innerHeight;
      const p = Math.min(
        1,
        Math.max(0, (vh * 0.85 - r.top) / (r.height + vh * 0.35))
      );
      el.style.setProperty("--progress", p.toFixed(3));
      if (p >= 1) {
        done = true;
        el.setAttribute("data-done", "");
        stop();
        io.disconnect();
      }
    };
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(compute);
    };
    const io = new IntersectionObserver(
      ([e]) => {
        if (done) return;
        if (e?.isIntersecting) {
          if (!listening) {
            listening = true;
            window.addEventListener("scroll", schedule, { passive: true });
          }
          compute();
        } else {
          stop();
        }
      },
      { rootMargin: "25% 0px 25% 0px" }
    );
    el.setAttribute("data-driven", "");
    io.observe(el);
    return () => {
      stop();
      io.disconnect();
    };
  }, []);
  return ref;
}
