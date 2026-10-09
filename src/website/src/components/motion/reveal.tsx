import { createElement, type CSSProperties, type ReactNode } from "react";
import { useInView } from "../../lib/use-in-view";

export function Reveal({
  as = "div",
  delay = 0,
  settle = false,
  className,
  children,
}: {
  as?: "div" | "li" | "figure";
  delay?: number;
  settle?: boolean;
  className?: string;
  children: ReactNode;
}) {
  const ref = useInView<HTMLElement>();
  return createElement(
    as,
    {
      ref,
      className,
      "data-reveal": settle ? "settle" : "",
      style: { "--d": `${delay}ms` } as CSSProperties,
    },
    children
  );
}
