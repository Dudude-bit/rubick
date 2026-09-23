import { logInfo } from "@/lib/logger";

/** Milliseconds from page load to: `main.tsx` running, the first render, the first frame. */
export type StartupMark = "main" | "root" | "painted";

const PREFIX = "rubick:";

export function markStartup(mark: StartupMark): void {
  performance.mark(PREFIX + mark);
}

function at(mark: StartupMark): number | null {
  const entry = performance.getEntriesByName(PREFIX + mark)[0];
  return entry ? Math.round(entry.startTime) : null;
}

let reported = false;

export function reportStartup(): void {
  if (reported) return;
  reported = true;
  logInfo("startup", {
    context: "startup",
    data: { mainMs: at("main"), rootMs: at("root"), paintedMs: at("painted") },
  });
}
