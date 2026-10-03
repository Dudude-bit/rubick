import { useEffect, useState } from "react";

import { stallWatch, type StallReport } from "@/lib/stall-watch";

/** The stall watch's report, refreshed as it changes and as its window slides. */
export function useStalls(): StallReport {
  const [report, setReport] = useState(() => stallWatch.report());
  useEffect(() => {
    const refresh = () => setReport(stallWatch.report());
    const stop = stallWatch.subscribe(refresh);
    // The window slides on its own: a stall ages out with nothing else
    // happening, and the indicator has to go with it.
    const timer = setInterval(refresh, 10_000);
    return () => {
      stop();
      clearInterval(timer);
    };
  }, []);
  return report;
}
