import { useEffect, useRef } from "react";

import { forgetRefusals } from "@/lib/refusals";
import { useWindowActivity } from "@/lib/window-activity";

export const REFUSAL_RECHECK_MS = 60_000;

/**
 * A kept refusal answers every ask itself, so access that came back is never
 * noticed until the reader presses retry. Asks again, once per visit and on
 * each return to the window, when the refusal is older than a minute.
 */
export function useRecheckRefusal(
  refusedAt: number | null,
  retry: () => unknown
) {
  const focused = useWindowActivity((state) => state.focused);
  const latest = useRef({ refusedAt, retry });
  useEffect(() => {
    latest.current = { refusedAt, retry };
  });
  const seen = refusedAt !== null;
  useEffect(() => {
    if (!focused || !seen) return;
    const { refusedAt: at, retry: ask } = latest.current;
    if (at === null || Date.now() - at < REFUSAL_RECHECK_MS) return;
    forgetRefusals();
    void ask();
  }, [focused, seen]);
}
