import type { CSSProperties } from "react";

import { usePeek } from "@/hooks/usePeek";
import { usePeekWidth } from "./peek-width";

/** The page ends where an open peek begins, so no column or banner of it lies under the peek out of reach. */
export function usePeekDock(): CSSProperties | undefined {
  const { target } = usePeek();
  const { width } = usePeekWidth();
  return target ? { marginRight: width } : undefined;
}
