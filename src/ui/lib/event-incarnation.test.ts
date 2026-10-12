import { describe, expect, it } from "vite-plus/test";

import type { EventInfo } from "@/generated/types";
import { earlierObjects, involvedUid } from "./event-incarnation";

let n = 0;
const event = (
  kind: string,
  name: string,
  uid: string | null,
  at: string | null
): EventInfo => ({
  name: `ev-${++n}`,
  namespace: "lena-sandbox",
  uid: `event-${n}`,
  type: "Normal",
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
    expect([...earlierObjects([fresh, old])]).toEqual(["d10287fd"]);
  });

  /** Fails if a read of the object there now is not what decides, over the events' own order. */
  it("calls every uid but the one read now earlier, even one the events never contradict", () => {
    const current = () => "4afe41e6";
    expect([...earlierObjects([old], current)]).toEqual(["d10287fd"]);
    expect([...earlierObjects([fresh], current)]).toEqual([]);
  });

  /** Fails if an undated event lets one object be called the earlier with nothing to order them by. */
  it("names no earlier object when the events cannot be put in order", () => {
    const undated = event("Pod", "wd-demo", "d10287fd", null);
    expect([...earlierObjects([fresh, undated])]).toEqual([]);
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
    expect([...earlierObjects([kubelet, controller])]).toEqual([]);
  });
});
