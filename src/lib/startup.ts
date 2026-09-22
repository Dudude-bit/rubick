import { logInfo } from "@/lib/logger";

/**
 * How long the window took to show something, measured from the moment the
 * webview began loading the page: every script before `main.tsx`, then the
 * wait before the first render, then the first frame of the app.
 */
export type StartupMark = "main" | "root" | "painted";

const PREFIX = "rubick:";

export function markStartup(mark: StartupMark): void {
  performance.mark(PREFIX + mark);
}

/** Milliseconds from page load to a mark, or null for one never reached. */
function at(mark: StartupMark): number | null {
  const entry = performance.getEntriesByName(PREFIX + mark)[0];
  return entry ? Math.round(entry.startTime) : null;
}

let reported = false;

/** One line in `rubick.log` per launch, next to the Rust side's own. */
export function reportStartup(): void {
  if (reported) return;
  reported = true;
  logInfo("startup", {
    context: "startup",
    data: { mainMs: at("main"), rootMs: at("root"), paintedMs: at("painted") },
  });
}
