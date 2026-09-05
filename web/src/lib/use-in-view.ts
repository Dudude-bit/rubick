import { useEffect, useRef } from "react";

const observers = new Map<string, IntersectionObserver>();

function observe(el: Element, margin: string) {
  if (!("IntersectionObserver" in window)) {
    el.setAttribute("data-in", "");
    return () => {};
  }
  let observer = observers.get(margin);
  if (!observer) {
    observer = new IntersectionObserver(
      (entries, io) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          e.target.setAttribute("data-in", "");
          io.unobserve(e.target);
        }
      },
      { rootMargin: margin }
    );
    observers.set(margin, observer);
  }
  observer.observe(el);
  return () => observer.unobserve(el);
}

export function useInView<T extends HTMLElement>(margin = "0px 0px -15% 0px") {
  const ref = useRef<T>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    return observe(el, margin);
  }, [margin]);
  return ref;
}
