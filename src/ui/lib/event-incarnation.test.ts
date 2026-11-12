import { describe, expect, it } from "vite-plus/test";

import type { EventInfo } from "@/generated/types";
import {
  involvedUid,
  nameKey,
  namedOf,
  namesToAsk,
  pastObjects,
  pastOf,
  refOfNamed,
} from "./event-incarnation";
import { getApiVersion } from "./resource-registry";

let n = 0;
const event = (
  kind: string,
  name: string,
  uid: string | null,
  at: string | null,
  type = "Normal",
  apiVersion = getApiVersion(kind)
): EventInfo => ({
  name: `ev-${++n}`,
  namespace: "lena-sandbox",
  uid: `event-${n}`,
  type,
  reason: "Started",
  message: null,
  source: null,
  involvedObject: { apiVersion, kind, name, namespace: "lena-sandbox", uid },
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
      "lena-sandbox/HorizontalPodAutoscaler.autoscaling/hello-web",
    ]);
  });
});

describe("a custom kind that shares a built-in's name", () => {
  const KNATIVE = "serving.knative.dev/v1";
  const core = event("Service", "web", "s1", "2026-10-12T01:00:00Z");
  const knative = event(
    "Service",
    "web",
    "k1",
    "2026-10-12T01:05:00Z",
    "Warning",
    KNATIVE
  );

  /**
   * A Knative Service and the core Service it makes under its own name hold
   * that name at once. Fails if they are read as two objects of one name,
   * which calls the one whose events began first an earlier object.
   */
  it("is another name, not an earlier or a later object of the built-in's", () => {
    expect([...pastObjects([core, knative])]).toEqual([]);
    expect([...namesToAsk([core, knative]).keys()]).toEqual([
      "lena-sandbox/Service.serving.knative.dev/web",
    ]);
  });

  /** Fails if whoever is asked who holds the name is not told which group's kind is meant. */
  it("asks who holds the name with the group its event gave", () => {
    const asked: unknown[] = [];
    pastObjects([knative], (named) => {
      asked.push(named);
      return undefined;
    });
    expect(asked).toEqual([
      {
        kind: "Service",
        group: "serving.knative.dev",
        namespace: "lena-sandbox",
        name: "web",
      },
    ]);
  });

  /**
   * The kubelet names its Node with no `apiVersion`, and the node controller
   * with `v1`: keyed apart, one node was two names, and the kubelet's was
   * never asked who holds it. Fails if an event that names no group is not
   * the built-in of its kind's name, or is filed with a namesake's group.
   */
  it("reads an event that names no group as the built-in of that name", () => {
    const unsaid: EventInfo = {
      ...core,
      involvedObject: { ...core.involvedObject, apiVersion: undefined },
    };
    expect(namedOf(unsaid).group).toBe("");
    expect([unsaid, core, knative].map((e) => nameKey(namedOf(e)))).toEqual([
      "lena-sandbox/Service/web",
      "lena-sandbox/Service/web",
      "lena-sandbox/Service.serving.knative.dev/web",
    ]);
  });

  /**
   * Fails if a kind no built-in is named like, in an event that names no
   * group, is filed under the core group: no group is known for it, and it
   * is no kind anyone can read.
   */
  it("knows no group for a kind no built-in has, where the event names none", () => {
    const widget = event("Widget", "w1", "u1", null, "Warning", "");
    const said = event("Widget", "w1", "u1", null, "Warning", "acme.io/v1");
    expect(namedOf(widget).group).toBeNull();
    expect(nameKey(namedOf(widget))).not.toBe(nameKey(namedOf(said)));
    expect(nameKey(namedOf(widget))).toBe("lena-sandbox/Widget?/w1");
  });

  /**
   * A deleted node's kubelet warnings kept a live link: its name was never
   * among those asked, and no answer was read under the key its rows go by.
   * Fails if the kubelet's Node event is not asked by the name the node
   * controller's is, or a name nothing holds does not make its row gone.
   */
  it("asks who holds a Node its kubelet warned about, and reads its rows by that answer", () => {
    const kubelet = event("Node", "n1", "n1", null, "Warning", "");
    const controller = event("Node", "n1", "5e1f", null);
    const asked = namesToAsk([kubelet, controller]);
    expect([...asked]).toEqual([
      [
        "lena-sandbox/Node/n1",
        { kind: "Node", group: "", namespace: "lena-sandbox", name: "n1" },
      ],
    ]);
    const nobody = new Set(asked.keys());
    expect(pastOf(kubelet, new Map(), nobody)).toBe("gone");
    expect(pastOf(kubelet, new Map(), new Set())).toBeUndefined();
  });

  /**
   * An Events row about a Knative Service linked to the core Service of its
   * name. Fails if a namesake opens anywhere but its own CRD's address, if
   * one no CRD defines opens the built-in, or if an event that names no
   * group loses the link its kind's name gives it.
   */
  it("is addressed by the CRD of its group, and by its name alone where the event names no group", () => {
    const crdOf = (group: string, kind: string) =>
      group === "serving.knative.dev" && kind === "Service"
        ? "services.serving.knative.dev"
        : null;
    expect(refOfNamed(namedOf(knative), crdOf)).toEqual({
      kind: "Service",
      name: "web",
      namespace: "lena-sandbox",
      crd: "services.serving.knative.dev",
    });
    expect(refOfNamed(namedOf(knative), () => null).crd).toBeNull();
    expect(refOfNamed(namedOf(core), crdOf).crd).toBeUndefined();
    const unsaid: EventInfo = {
      ...knative,
      involvedObject: { ...knative.involvedObject, apiVersion: undefined },
    };
    expect(refOfNamed(namedOf(unsaid), crdOf).crd).toBeUndefined();
  });
});
