import { describe, expect, it } from "vite-plus/test";
import { EyeOff } from "lucide-react";

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

  /**
   * Sam's `web`: the Status row said only "This Service publishes no
   * endpoint" while the trace below it knew why. Fails if the reason drops
   * back to the title.
   */
  it("gives the named port no container declares as the reason", () => {
    const health = serviceHealthOf(
      SELECTING,
      published({
        slices: 0,
        stop: {
          reason: "publishesNothing",
          service: SERVICE,
          selector: "app=web",
          pods: 2,
          readyPods: 2,
          unnamedPorts: ["web"],
        },
      }),
      null
    );
    expect(serviceHealthWords(health, t)).toMatchObject({
      label: "no endpoints",
      reason:
        "No container declares the port the Service asks for (targetPort: web), so nothing is published",
    });
  });

  /**
   * Lena scaled hello-web to zero and its Service read red "no endpoints" on
   * the page, the list and the Overview. Fails if a selector behind workloads
   * at zero is drawn as a fault, or one that matches nothing stops being one.
   */
  it("calls a Service whose workloads are scaled to zero idle, calmly", () => {
    const deployment: ObjectRef = {
      kind: "Deployment",
      name: "hello-web",
      namespace: "lena-sandbox",
      existence: "present",
      facts: null,
    };
    const idle = serviceHealthOf(
      SELECTING,
      published({
        slices: 0,
        stop: {
          reason: "scaledToZero",
          service: SERVICE,
          selector: "app=hello-web",
          workloads: [deployment],
        },
      }),
      null
    );
    expect(idle.state).toBe("idle");
    expect(serviceHealthWords(idle, t)).toMatchObject({
      label: "idle",
      role: "neutral",
      reason: "No pods by intent: hello-web is scaled to zero",
    });

    const empty = serviceHealthOf(
      SELECTING,
      published({
        slices: 0,
        stop: {
          reason: "selectsNothing",
          service: SERVICE,
          selector: "app=hello-web",
          near: null,
        },
      }),
      null
    );
    expect(serviceHealthWords(empty, t).role).toBe("err");
  });

  /** Lena could not tell whom "он запрашивает" meant; fails if the Service stops being the asker. */
  it("names the Service as the one that asks for the port, in Russian", () => {
    expect(
      translate("ru", "nav", "stopUnnamedPortCause", {
        asked: "targetPort: web",
      })
    ).toBe(
      "Ни один контейнер не объявляет порт, который запрашивает Service (targetPort: web), поэтому ничего не публикуется"
    );
  });

  /**
   * Lena read "2 пода несут app=unready-demo" in the Services tooltip and on
   * the Overview, where a native says "у 2 подов метка app=unready-demo". Fails if the clause
   * after the colon repeats the verdict instead of naming a cause, or the
   * place that knows one. Where only the slices were read, the count is
   * theirs and the sentence says so: Marco read "1 pod carries" about a pod
   * nobody had read.
   */
  it.each([
    [
      "failingReadiness",
      "У 2 подов метка app=unready-demo, и ни один не готов: не проходят проверку готовности",
    ],
    [
      "inSlices",
      "Эндпоинты для app=unready-demo называют 2 адреса, и ни один не готов: причину покажет страница Service",
    ],
  ] as const)(
    "follows none ready with a cause when the pods are %s",
    (why, sentence) => {
      const ru: T = (section, key, values) =>
        translate("ru", section, key, values);
      const health = serviceHealthOf(
        SELECTING,
        published({
          notReady: 2,
          stop: {
            reason: "noneReady",
            service: SERVICE,
            selector: "app=unready-demo",
            pods: 2,
            why,
          },
        }),
        null
      );
      expect(serviceHealthWords(health, ru).reason).toBe(sentence);
    }
  );

  /**
   * The same sentence at every count: "у 21 пода" and "у 5 подов" take
   * different forms, and "несут" for a label read as machine Russian at all
   * of them.
   */
  it.each([
    [1, "У 1 пода метка app=web, и он не готов"],
    [2, "У 2 подов метка app=web, и ни один не готов"],
    [5, "У 5 подов метка app=web, и ни один не готов"],
    [21, "У 21 пода метка app=web, и он не готов"],
  ])("says who has the label with %i pods in Russian", (n, sentence) => {
    expect(
      translate("ru", "count", "podsCarryNotReady", {
        n,
        selector: "app=web",
      })
    ).toBe(sentence);
  });

  /** "За app=tls-demo пока ничего не опубликовано" read as machine Russian on the Overview. */
  it("says in plain Russian that nothing is published for the selector yet", () => {
    const ru: T = (section, key, values) =>
      translate("ru", section, key, values);
    const health = serviceHealthOf(
      SELECTING,
      published({
        stop: {
          reason: "publishesNothingYet",
          service: SERVICE,
          selector: "app=tls-demo",
        },
      }),
      null
    );
    expect(serviceHealthWords(health, ru).reason).toBe(
      "По селектору app=tls-demo пока ничего не опубликовано"
    );
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

describe("a Service whose workloads wait on their pods", () => {
  const waiting = (why: "comingUp" | "podsUnread") =>
    serviceHealthOf(
      SELECTING,
      published({
        notReady: 1,
        stop: {
          reason: "noneReady",
          service: SERVICE,
          selector: "app=ledger",
          pods: 1,
          why,
        },
      }),
      null
    );

  /**
   * Marco's ledger: the slices said its one address was not ready, its pods
   * could not be read, and the Service drew a red fault beside its
   * Deployment's grey unread verdict. Fails if it takes a colour, loses the
   * EyeOff mark, or stops saying the pods were not read.
   */
  it("reads none ready without a fault's colour where the pods were not read", () => {
    const words = serviceHealthWords(waiting("podsUnread"), t);
    expect(waiting("podsUnread").state).toBe("podsUnread");
    expect(words.label).toBe("none ready");
    expect(words.role).toBe("neutral");
    expect(words.glyph).toBe(EyeOff);
    expect(words.reason).toBe(
      "The endpoints list 1 address for app=ledger, and it is not ready: pods not read, so whether they are starting is not known"
    );
  });

  /**
   * A Service in front of a Deployment pulling its first image read red
   * none ready while the Deployment read coming up. Fails if the two
   * disagree, or the Service is drawn as a fault.
   */
  it("reads coming up where its workloads are still starting their pods", () => {
    const words = serviceHealthWords(waiting("comingUp"), t);
    expect(waiting("comingUp").state).toBe("comingUp");
    expect(words.label).toBe("coming up");
    expect(words.role).toBe("pending");
    expect(words.reason).toBe(
      "1 pod carries app=ledger, and it is not ready: still starting"
    );
  });
});
