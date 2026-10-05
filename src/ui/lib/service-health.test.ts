import { describe, expect, it } from "vite-plus/test";

import { translate } from "@/i18n";
import type { T } from "@/i18n/useT";
import type { ObjectRef, ServicePublished } from "@/generated/types";
import {
  healthFromConnections,
  serviceHealthOf,
  serviceHealthWords,
} from "./service-health";

const t: T = (section, key, values) => translate("en", section, key, values);

const SERVICE: ObjectRef = {
  kind: "Service",
  name: "topology-demo",
  namespace: "k8s-gui-test",
  existence: "present",
  facts: null,
};

const published = (over: Partial<ServicePublished> = {}): ServicePublished => ({
  service: SERVICE,
  source: "slices",
  slices: 1,
  ready: 0,
  draining: 0,
  notReady: 0,
  unrouted: 0,
  unroutedReady: 0,
  ports: [],
  endpoints: [],
  whole: true,
  unpublished: [],
  stop: null,
  ...over,
});

const SELECTING = { type: "ClusterIP", selectorless: false };

describe("one verdict for a Service on every surface", () => {
  /**
   * topology-demo, read twice: the page lists the pods and knows they are
   * unscheduled; the list holds only the empty slice. Both must draw the
   * same badge, the page only a sharper reason. Fails if the badge is
   * chosen from the stop instead of the published counts.
   */
  it("draws the same badge whether or not the pods were read", () => {
    const page = serviceHealthOf(
      SELECTING,
      published({
        stop: {
          reason: "noneReady",
          service: SERVICE,
          selector: "app=topology-demo",
          pods: 2,
          why: "unscheduled",
        },
      }),
      null
    );
    const list = serviceHealthOf(
      SELECTING,
      published({
        stop: {
          reason: "publishesNothingYet",
          service: SERVICE,
          selector: "app=topology-demo",
        },
      }),
      null
    );
    expect(page.state).toBe("noEndpoints");
    expect(list.state).toBe("noEndpoints");

    const words = serviceHealthWords(page, t);
    expect(words.role).toBe("err");
    expect(words.label).toBe("no endpoints");
    expect(words.reason).toContain("not scheduled");
  });

  /** Addresses in the slices, none serving: the outage on running pods. */
  it("calls addresses that are listed and not ready none ready", () => {
    const health = serviceHealthOf(SELECTING, published({ notReady: 2 }), null);
    expect(health.state).toBe("noneReady");
    expect(serviceHealthWords(health, t).role).toBe("err");
  });

  /**
   * mixed-port-demo: one pod published, one in a slice with no port. The
   * Endpoints list drew it green; it is partly down.
   */
  it("says partly when some addresses take no traffic", () => {
    const health = serviceHealthOf(
      SELECTING,
      published({ ready: 1, unrouted: 1 }),
      null
    );
    expect(health).toEqual({ state: "partly", serving: 1, total: 2 });
    const words = serviceHealthWords(health, t);
    expect(words.role).toBe("warn");
    expect(words.label).toBe("1 of 2 ready");
  });

  it("calls a Service ready when every address serves", () => {
    const health = serviceHealthOf(SELECTING, published({ ready: 2 }), null);
    expect(serviceHealthWords(health, t)).toMatchObject({
      role: "ok",
      label: "2 ready",
    });
  });

  /**
   * The thesis: what it publishes was not read, so it is not "no
   * endpoints". Fails if a missing answer falls through to a verdict.
   */
  it("says not checked, with the reason, when nothing was read", () => {
    const health = serviceHealthOf(SELECTING, undefined, "forbidden");
    expect(health).toEqual({ state: "unknown", why: "forbidden" });
    const words = serviceHealthWords(health, t);
    expect(words.role).toBe("neutral");
    expect(words.reason).toBe("forbidden");
  });

  /**
   * Still being read is not "not checked": one settles in a second, the
   * other is final. Fails if the two share a label again.
   */
  it("tells a read still on its way from a refused one", () => {
    const reading = serviceHealthWords(
      serviceHealthOf(SELECTING, undefined, null),
      t
    );
    const refused = serviceHealthWords(
      serviceHealthOf(SELECTING, undefined, "forbidden"),
      t
    );
    expect(reading.label).toBe("still reading");
    expect(refused.label).toBe("not checked");
  });

  /** A DNS alias and a hand-written Service are not failures. */
  it("leaves an ExternalName and a selectorless Service neutral", () => {
    expect(
      serviceHealthWords(
        serviceHealthOf(
          { type: "ExternalName", selectorless: true },
          undefined,
          null
        ),
        t
      ).role
    ).toBe("neutral");
    expect(
      serviceHealthOf(
        { type: "ClusterIP", selectorless: true },
        published(),
        null
      ).state
    ).toBe("selectorless");
  });

  /**
   * The peek and the page read the Service's neighbourhood; refused, it is
   * "not checked" with the refusal, never "no endpoints".
   */
  it("says not checked when the neighbourhood was refused", () => {
    expect(healthFromConnections(undefined, new Error("forbidden"))).toEqual({
      state: "unknown",
      why: "forbidden",
    });
    expect(healthFromConnections(undefined, null)).toEqual({
      state: "unknown",
      why: null,
    });
  });
});
