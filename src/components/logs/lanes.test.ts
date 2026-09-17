import { describe, expect, it } from "vitest";

import type { ContainerInfo } from "@/generated/types";

import {
  GONE_LANE_COLOR,
  laneColors,
  laneLabel,
  laneName,
  laneNameCounts,
  laneOrderWith,
  type LanePod,
} from "./lanes";

const pod = (name: string, over: Partial<LanePod> = {}): LanePod => ({
  name,
  namespace: "default",
  containers: [] as ContainerInfo[],
  node: "node-a",
  run: null,
  ...over,
});

describe("lane colours", () => {
  /**
   * The list is rebuilt from every poll of the pod list. Handing out hues
   * by position meant one pod dropping out shifted every pod after it, so
   * the lines already in the buffer changed colour under the reader and
   * the replacement inherited the hue they were following — and the gutter
   * is the only thing identifying a lane in the default label mode.
   */
  it("keeps a lane's colour when a pod before it leaves the list", () => {
    let order: string[] = [];
    order = laneOrderWith(order, ["api-a", "api-b", "api-c"]);
    const first = laneColors(["api-a", "api-b", "api-c"], new Set(), order);
    order = laneOrderWith(order, ["api-b", "api-c"]);
    const after = laneColors(["api-b", "api-c"], new Set(["api-a"]), order);
    expect(after.get("api-b")).toBe(first.get("api-b"));
    expect(after.get("api-c")).toBe(first.get("api-c"));
  });

  it("greys a lane whose pod is gone and keeps its hue for nobody else", () => {
    let order = laneOrderWith([], ["api-a", "api-b"]);
    const first = laneColors(["api-a", "api-b"], new Set(), order);
    order = laneOrderWith(order, ["api-a", "api-b", "api-c"]);
    const after = laneColors(
      ["api-a", "api-b", "api-c"],
      new Set(["api-a"]),
      order
    );
    expect(after.get("api-a")).toBe(GONE_LANE_COLOR);
    expect(after.get("api-c")).not.toBe(first.get("api-b"));
  });
});

describe("lane names", () => {
  /**
   * A Job with `parallelism: 3` owns all three pods, and a retried CronJob
   * pod shares its Job with the pod it replaced. Named by the rule alone,
   * the legend draws identical chips and hiding one takes away lines with
   * nothing on screen saying which.
   */
  it("falls back to the pod when the rule's name covers more than one lane", () => {
    const pods = [
      pod("import-abc", { run: "import-orders" }),
      pod("import-def", { run: "import-orders" }),
    ];
    const taken = laneNameCounts(pods, "run");
    expect(laneName(pods[0], pods[0].name, "run", taken)).toBe(
      "import-orders/abc"
    );
    expect(laneName(pods[1], pods[1].name, "run", taken)).toBe(
      "import-orders/def"
    );
  });

  it("uses the rule's name alone where it names one lane", () => {
    const pods = [
      pod("api-a", { node: "node-1" }),
      pod("api-b", { node: "node-2" }),
    ];
    const taken = laneNameCounts(pods, "node");
    expect(laneName(pods[0], pods[0].name, "node", taken)).toBe("node-1");
    expect(laneLabel(pods[0], pods[0].name, "node", "full", taken)).toBe(
      "node-1"
    );
  });

  it("is the pod's name where the rule has nothing to say", () => {
    const one = pod("api-a", { node: null, run: null });
    expect(laneName(one, one.name, "node")).toBe("api-a");
    expect(laneName(one, one.name, "run")).toBe("api-a");
    expect(laneName(null, "api-gone", "pod")).toBe("api-gone");
  });
});
