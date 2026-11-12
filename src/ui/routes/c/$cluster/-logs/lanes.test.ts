import { describe, expect, it } from "vite-plus/test";

import type { ContainerInfo } from "@/generated/types";

import {
  GONE_LANE_COLOR,
  laneColors,
  laneLabels,
  laneName,
  shortLane,
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

const labelsOf = (
  pods: LanePod[],
  rule: Parameters<typeof laneLabels>[2],
  mode: Parameters<typeof laneLabels>[3]
) =>
  laneLabels(
    pods.map((each) => each.name),
    (key) => pods.find((each) => each.name === key) ?? null,
    rule,
    mode,
    laneNameCounts(pods, rule)
  );

describe("short lane labels", () => {
  /**
   * An EKS node is `ip-10-0-12-34.eu-west-1.compute.internal`: the last dash
   * of the whole name is the region's, so every lane of a DaemonSet read
   * `1.compute.internal`. Fails if a host name is cut anywhere but in its
   * own label.
   */
  it("cuts a node's host name in its own label, not in its domain", () => {
    expect(shortLane("ip-10-0-12-34.eu-west-1.compute.internal")).toBe("34");
    expect(shortLane("ip-10-0-12-34.ec2.internal")).toBe("34");
    expect(shortLane("node1.example.com")).toBe("node1");
    expect(shortLane("api-7d9f8c-x2kq9")).toBe("x2kq9");
  });

  /**
   * Two nodes in different subnets end in the same octet. Fails if lanes
   * share a chip and a row label: hiding one then takes away lines with
   * nothing on screen saying which node's.
   */
  it("keeps the whole name on the lanes whose short label is not theirs alone", () => {
    const pods = [
      pod("agent-a", { node: "ip-10-0-12-34.ec2.internal" }),
      pod("agent-b", { node: "ip-10-0-13-34.ec2.internal" }),
      pod("agent-c", { node: "ip-10-0-12-77.ec2.internal" }),
    ];
    const short = labelsOf(pods, "node", "short")!;
    expect([...short.values()]).toEqual([
      "ip-10-0-12-34.ec2.internal",
      "ip-10-0-13-34.ec2.internal",
      "77",
    ]);
    expect(new Set(short.values()).size).toBe(pods.length);
  });

  /** Fails if the colour-only mode starts labelling rows. */
  it("labels nothing where the colour alone tells the lanes apart", () => {
    expect(labelsOf([pod("api-a")], "pod", "colour")).toBeNull();
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
    expect(labelsOf(pods, "node", "full")?.get("api-a")).toBe("node-1");
  });

  it("is the pod's name where the rule has nothing to say", () => {
    const one = pod("api-a", { node: null, run: null });
    expect(laneName(one, one.name, "node")).toBe("api-a");
    expect(laneName(one, one.name, "run")).toBe("api-a");
    expect(laneName(null, "api-gone", "pod")).toBe("api-gone");
  });
});
