import { createContext, useContext, type CSSProperties } from "react";

import { usePeek } from "@/hooks/usePeek";
import { usePeekWidth } from "./peek-width";

/** The page's box between the tab bar and the status bar, which the peek opens inside so neither is covered. */
export const PeekHost = createContext<HTMLElement | null>(null);

/** Where the panel is portalled, and the position that keeps it inside that box. */
export function usePeekHost(): {
  container: HTMLElement | undefined;
  position: string | undefined;
} {
  const host = useContext(PeekHost);
  return {
    container: host ?? undefined,
    position: host ? "absolute" : undefined,
  };
}

/** The page ends where an open peek begins, so no column or banner of it lies under the peek out of reach. */
export function usePeekDock(): CSSProperties | undefined {
  const { target } = usePeek();
  const { width } = usePeekWidth();
  return target ? { marginRight: width } : undefined;
}
