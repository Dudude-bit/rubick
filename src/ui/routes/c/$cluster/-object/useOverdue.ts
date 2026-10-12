import { useEffect, useRef, useState } from "react";

import { useLastPassed } from "@/hooks/useNow";

/** How long a neighbourhood read may go unanswered before it is said not to have answered. */
export const PATH_PATIENCE_MS = 10_000;

/** Whether `waiting` has lasted `ms` without an end: a read that cannot finish ends in "no answer", never an endless "reading". */
export function useOverdue(waiting: boolean, ms: number): boolean {
  const [since, setSince] = useState<number | null>(null);
  const was = useRef(false);
  useEffect(() => {
    if (was.current === waiting) return;
    was.current = waiting;
    setSince(waiting ? Date.now() : null);
  }, [waiting]);
  const deadline = since === null ? null : since + ms;
  const passed = useLastPassed(deadline === null ? [] : [deadline]);
  return waiting && deadline !== null && passed >= deadline;
}
