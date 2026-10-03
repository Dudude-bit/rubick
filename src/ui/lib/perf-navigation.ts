import type { PerfRecorder } from "./perf";

export interface NavigationHost {
  history: Pick<History, "pushState" | "replaceState">;
  addEventListener(type: "popstate", listener: () => void): void;
  removeEventListener(type: "popstate", listener: () => void): void;
  now(): number;
  afterPaint(callback: () => void): void;
}

const browserHost = (): NavigationHost => ({
  history: window.history,
  addEventListener: (type, listener) => window.addEventListener(type, listener),
  removeEventListener: (type, listener) =>
    window.removeEventListener(type, listener),
  now: () => performance.now(),
  afterPaint: (callback) => requestAnimationFrame(() => callback()),
});

let active: {
  recorder: PerfRecorder;
  host: NavigationHost;
  startedAt: number | null;
} | null = null;

/**
 * Times every navigation from the moment the router writes history to the
 * first paint after the new page rendered. The start is read off `history`
 * rather than the router so the number means the same thing before and
 * after a router change.
 */
export function startNavigationWatch(
  recorder: PerfRecorder,
  host: NavigationHost = browserHost()
): () => void {
  const watch = { recorder, host, startedAt: null as number | null };
  const stamp = () => {
    watch.startedAt = host.now();
  };
  const { pushState, replaceState } = host.history;
  host.history.pushState = function (...args) {
    stamp();
    return pushState.apply(this, args);
  };
  host.history.replaceState = function (...args) {
    stamp();
    return replaceState.apply(this, args);
  };
  host.addEventListener("popstate", stamp);
  active = watch;
  return () => {
    host.history.pushState = pushState;
    host.history.replaceState = replaceState;
    host.removeEventListener("popstate", stamp);
    if (active === watch) active = null;
  };
}

/** The routed page for `pathname` has committed; records once it is painted. */
export function navigationRendered(name: string): void {
  const watch = active;
  if (!watch || watch.startedAt === null) return;
  const startedAt = watch.startedAt;
  watch.startedAt = null;
  watch.host.afterPaint(() => {
    const at = watch.host.now();
    watch.recorder.record({ kind: "navigation", name, ms: at - startedAt, at });
  });
}

const SECTIONS = new Set(["workloads", "network", "storage", "configuration"]);

/** A path reduced to its route's shape, so every pod page is one row. */
export function navigationName(pathname: string): string {
  const parts = pathname.split("/").filter(Boolean);
  if (parts.length <= 1 || SECTIONS.has(parts[0])) return `/${parts.join("/")}`;
  const [head] = parts;
  if (parts.length === 2) return `/${head}/:name`;
  if (parts.length === 3) return `/${head}/:namespace/:name`;
  return `/${head}/…`;
}
