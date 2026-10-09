import {
  createContext,
  useContext,
  useEffect,
  type CSSProperties,
} from "react";

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

/** The box only clips. A focus that scrolled it, into a peek still sliding in, pushed the page and the peek 97 px left. */
export function useHostUnscrolled(): void {
  const host = useContext(PeekHost);
  useEffect(() => {
    if (!host) return;
    const pin = () => {
      host.scrollLeft = 0;
      host.scrollTop = 0;
    };
    host.addEventListener("scroll", pin);
    return () => host.removeEventListener("scroll", pin);
  }, [host]);
}
