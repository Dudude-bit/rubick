import * as React from "react";

import { perf } from "@/lib/perf";

const onRender: React.ProfilerOnRenderCallback = (
  id,
  _phase,
  actualDuration,
  _base,
  _start,
  commitTime
) => {
  perf.record({ kind: "render", name: id, ms: actualDuration, at: commitTime });
};

/**
 * A React Profiler that feeds the recorder. In a production bundle React
 * never calls `onRender`, so render numbers exist only from `make dev` or a
 * profiling build; the report says as much when the renders map is empty.
 */
export function PerfProfiler({
  id,
  children,
}: {
  id: string;
  children: React.ReactNode;
}) {
  return (
    <React.Profiler id={id} onRender={onRender}>
      {children}
    </React.Profiler>
  );
}
