import { describe, expect, it } from "vite-plus/test";

import { PerfRecorder } from "./perf";
import {
  navigationName,
  navigationRendered,
  startNavigationWatch,
  type NavigationHost,
} from "./perf-navigation";

function fakeHost() {
  let clock = 0;
  const painted: Array<() => void> = [];
  const popstate = new Set<() => void>();
  const writes: string[] = [];
  const history = {
    pushState: (_d: unknown, _u: string, url?: string | URL | null) => {
      writes.push(`push ${url}`);
    },
    replaceState: (_d: unknown, _u: string, url?: string | URL | null) => {
      writes.push(`replace ${url}`);
    },
  };
  const host: NavigationHost = {
    history,
    addEventListener: (_t, l) => popstate.add(l),
    removeEventListener: (_t, l) => popstate.delete(l),
    now: () => clock,
    afterPaint: (callback) => painted.push(callback),
  };
  return {
    host,
    history,
    writes,
    advance: (ms: number) => (clock += ms),
    paint: () => painted.splice(0).forEach((f) => f()),
    back: () => popstate.forEach((l) => l()),
  };
}

describe("the navigation mark", () => {
  /** Without the start stamped on history, a render after a click would be
   *  timed from nothing and the recorder would hold no navigations at all. */
  it("times a navigation from the history write to the paint after its page", () => {
    const recorder = new PerfRecorder();
    recorder.start(0);
    const fake = fakeHost();
    const stop = startNavigationWatch(recorder, fake.host);

    fake.advance(10);
    fake.history.pushState(null, "", "/pods/prod/api");
    fake.advance(120);
    navigationRendered("/pods/:namespace/:name");
    fake.advance(16);
    fake.paint();
    stop();

    const row = recorder.report()?.navigations["/pods/:namespace/:name"];
    expect(row?.count).toBe(1);
    expect(row?.max).toBe(136);
    expect(fake.writes).toEqual(["push /pods/prod/api"]);
  });

  /** A page that renders without a navigation (the first mount, a refetch)
   *  would otherwise be recorded as an instant one and pull p50 down. */
  it("records nothing for a render no navigation started", () => {
    const recorder = new PerfRecorder();
    recorder.start(0);
    const fake = fakeHost();
    const stop = startNavigationWatch(recorder, fake.host);

    navigationRendered("/workloads/pods");
    fake.paint();
    stop();

    expect(recorder.report()?.navigations).toEqual({});
  });

  /** Back and forward never call pushState; only popstate says they happened. */
  it("times a back navigation from popstate", () => {
    const recorder = new PerfRecorder();
    recorder.start(0);
    const fake = fakeHost();
    const stop = startNavigationWatch(recorder, fake.host);

    fake.back();
    fake.advance(40);
    navigationRendered("/workloads/pods");
    fake.paint();
    stop();

    expect(recorder.report()?.navigations["/workloads/pods"]?.max).toBe(40);
  });

  /** A watch that outlived its recording would keep wrapping history for a
   *  session nobody is timing. */
  it("hands history back untouched when it stops", () => {
    const recorder = new PerfRecorder();
    const fake = fakeHost();
    const { pushState, replaceState } = fake.history;
    const stop = startNavigationWatch(recorder, fake.host);
    expect(fake.history.pushState).not.toBe(pushState);
    stop();
    expect(fake.history.pushState).toBe(pushState);
    expect(fake.history.replaceState).toBe(replaceState);
  });
});

describe("a route's shape", () => {
  /** One row per object would make the table as long as the session. */
  it("folds object names and keeps list paths", () => {
    expect(navigationName("/workloads/pods")).toBe("/workloads/pods");
    expect(navigationName("/pods/prod/api-7f9")).toBe("/pods/:namespace/:name");
    expect(navigationName("/nodes/n1")).toBe("/nodes/:name");
    expect(navigationName("/")).toBe("/");
  });
});
