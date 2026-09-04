import { useEffect, useRef } from "react";

let observer: IntersectionObserver | null = null;

function observe(el: Element) {
  if (!("IntersectionObserver" in window)) {
    el.setAttribute("data-in", "");
    return () => {};
  }
  observer ??= new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        e.target.setAttribute("data-in", "");
        observer?.unobserve(e.target);
      }
    },
    { rootMargin: "0px 0px -15% 0px" }
  );
  observer.observe(el);
  return () => observer?.unobserve(el);
}

export function useInView<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    return observe(el);
  }, []);
  return ref;
}
