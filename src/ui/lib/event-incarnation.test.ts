import { describe, expect, it } from "vite-plus/test";

import type { EventInfo } from "@/generated/types";
import { involvedUid, namesToAsk, pastObjects } from "./event-incarnation";

let n = 0;
const event = (
  kind: string,
  name: string,
  uid: string | null,
  at: string | null,
  type = "Normal"
): EventInfo => ({
  name: `ev-${++n}`,
  namespace: "lena-sandbox",
  uid: `event-${n}`,
  type,
  reason: "Started",
  message: null,
  source: null,
  involvedObject: { kind, name, namespace: "lena-sandbox", uid },
  count: 1,
  firstTimestamp: at,
  lastTimestamp: at,
});

const old = event("Pod", "wd-demo", "d10287fd", "2026-10-12T01:00:00Z");
const fresh = event("Pod", "wd-demo", "4afe41e6", "2026-10-12T01:05:00Z");

describe("which object of a name an event is about", () => {
  /**
   * wd-demo, made again under its name, merged its predecessor's FailedMount
   * into its own story. Fails if two uids of one name are not told apart by
   * which began later.
   */
  it("calls the object whose events began first the earlier one", () => {
    expect([...pastObjects([fresh, old])]).toEqual([["d10287fd", "earlier"]]);
  });

  /** Fails if a read of the object there now is not what decides, over the events' own order. */
  it("calls every uid but the one read now earlier, even one the events never contradict", () => {
    const current = () => "4afe41e6";
    expect([...pastObjects([old], current)]).toEqual([["d10287fd", "earlier"]]);
    expect([...pastObjects([fresh], current)]).toEqual([]);
  });

  /**
   * Lena deleted both HPAs named hello-web: the first one's chip said another
   * HPA held the name while the second's said nothing did. Fails if a name
   * the cluster answered nothing holds leaves any of its objects called
   * earlier, or any of them not called gone.
   */
  it("calls every object of a name nothing holds gone, the latest one too", () => {
    const nobody = () => null;
    expect(new Map(pastObjects([fresh, old], nobody))).toEqual(
      new Map([
        ["d10287fd", "gone"],
        ["4afe41e6", "gone"],
      ])
    );
  });

  /** Fails if an undated event lets one object be called the earlier with nothing to order them by. */
  it("names no earlier object when the events cannot be put in order", () => {
    const undated = event("Pod", "wd-demo", "d10287fd", null);
    expect([...pastObjects([fresh, undated])]).toEqual([]);
  });

  /**
   * The kubelet writes a Node's name where its uid belongs, and the node
   * controller writes the real uid. Read as two objects, every node would
   * have an earlier self.
   */
  it("reads a uid equal to the name as no uid at all", () => {
    const kubelet = event(
      "Node",
      "k3d-agent-0",
      "k3d-agent-0",
      "2026-10-12T01:00:00Z"
    );
    const controller = event(
      "Node",
      "k3d-agent-0",
      "5e1f",
      "2026-10-12T01:05:00Z"
    );
    expect(involvedUid(kubelet)).toBeNull();
    expect([...pastObjects([kubelet, controller])]).toEqual([]);
  });
});

describe("which names are worth asking who holds them", () => {
  /**
   * The list view asked nothing, so a name two objects had kept the chip the
   * events' order gave it. Fails if a name with two objects, or one whose own
   * events warn, is not asked, or if a pod's warning asks the pod rather than
   * leaving it to its owner.
   */
  it("asks a name several objects have had and one whose own events warn, not a warning pod", () => {
    const warned = event(
      "HorizontalPodAutoscaler",
      "hello-web",
      "f0644886",
      null,
      "Warning"
    );
    const crashing = event("Pod", "api-7b6d9", "a1", null, "Warning");
    const quiet = event("Service", "api", "s1", null);
    expect([
      ...namesToAsk([old, fresh, warned, crashing, quiet]).keys(),
    ]).toEqual([
      "lena-sandbox/Pod/wd-demo",
      "lena-sandbox/HorizontalPodAutoscaler/hello-web",
    ]);
  });
});
