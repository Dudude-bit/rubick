import { describe, expect, it } from "vite-plus/test";
import { EyeOff } from "lucide-react";

import { translate } from "@/i18n";
import type { T } from "@/i18n/useT";
import type {
  ChainStop,
  NotServing,
  ObjectRef,
  ServicePublished,
  SharedCause,
} from "@/generated/types";
import { chainStopHop, describeStop, stopMood } from "./connections";
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
          cause: null,
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
          podsUnread: false,
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
          makersRead: true,
        },
      }),
      null
    );
    expect(serviceHealthWords(empty, t).role).toBe("err");
  });

  /**
   * Marco, who may list pods and not Deployments, read idle-web at zero as
   * red "no endpoints" and "there is simply nothing behind it". Fails if a
   * selector matching no pod where the workloads were not read is a fault,
   * or stops saying which read is missing.
   */
  it("calls a Service selecting nothing unconfirmed where its workloads were not read", () => {
    const stop: ChainStop = {
      reason: "selectsNothing",
      service: SERVICE,
      selector: "app=idle-web",
      near: null,
      makersRead: false,
    };
    const health = serviceHealthOf(
      SELECTING,
      published({ slices: 0, stop }),
      null
    );
    expect(health.state).toBe("podsUnread");
    expect(serviceHealthWords(health, t)).toMatchObject({
      label: "no endpoints",
      role: "neutral",
      reason:
        "No pod carries app=idle-web: workloads not read, so whether one is scaled to zero is not known",
    });
    expect(stopMood(stop)).toBe("unchecked");
    expect(describeStop(stop, t).note).toBe(
      "Anything that reaches this address gets a connection refused. The Deployments and StatefulSets here could not be read, so whether one is scaled to zero or was refused its pods is not known."
    );
    const near = {
      pods: [SERVICE],
      carries: "app=idle-web",
      lacks: "tier=web",
    };
    expect(stopMood({ ...stop, near })).toBe("fault");
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
            cause: null,
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
          podsUnread: false,
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
   * mixed-port-demo: one pod published, one in a slice with no port, both
   * ready in their slices. The list said "1 of 2 ready" and the peek "1 of
   * its addresses takes no traffic". Fails if the address with no port is
   * counted not ready, or its readiness is dropped where the slices said it,
   * or if the sentence stops saying it is the slice that lists no ports.
   */
  it("counts traffic and readiness apart when an address has none of the ports", () => {
    const health = serviceHealthOf(
      SELECTING,
      published({ ready: 1, unrouted: 1, unroutedReady: 1 }),
      null
    );
    expect(health).toEqual({
      state: "partly",
      ready: 1,
      draining: 0,
      total: 2,
      unrouted: 1,
      unroutedReady: 1,
    });
    const words = serviceHealthWords(health, t);
    expect(words.role).toBe("warn");
    expect(words.label).toBe("1 of 2 takes traffic");
    expect(words.reason).toBe(
      "1 ready address is in an EndpointSlice that lists no ports, as it has none of the ports this Service targets, so no traffic is sent to it"
    );
  });

  /** The compact answer the sidebar reads carries no readiness for those addresses. Fails if it claims one. */
  it("leaves readiness unsaid for an address with no port where it was not read", () => {
    const { unroutedReady: _, ...compact } = published({
      ready: 1,
      notReady: 1,
      unrouted: 1,
    });
    const words = serviceHealthWords(
      serviceHealthOf(SELECTING, compact, null),
      t
    );
    expect(words.label).toBe("1 of 3 takes traffic");
    expect(words.reason).toBe(
      "1 of its addresses takes no traffic, 1 address is in an EndpointSlice that lists no ports, as it has none of the ports this Service targets, so no traffic is sent to it"
    );
  });

  /**
   * Sam's big-pull right after delete and apply: the old pod's endpoint
   * ready false, serving true, terminating true, kubectl endpoints <none>,
   * and the headline said "1 ready" in green. Fails if a draining address is
   * counted ready again.
   */
  it("counts a Service down to a draining address as draining, never ready", () => {
    const health = serviceHealthOf(SELECTING, published({ draining: 1 }), null);
    expect(health).toEqual({ state: "draining", draining: 1, total: 1 });
    const words = serviceHealthWords(health, t);
    expect(words.label).toBe("1 draining");
    expect(words.role).toBe("warn");
  });

  /**
   * A second later the new pod was ready beside the old one draining, and
   * the headline said "2 ready". Fails if the draining one joins the ready.
   */
  it("says one of two ready with the draining one named apart", () => {
    const health = serviceHealthOf(
      SELECTING,
      published({ ready: 1, draining: 1 }),
      null
    );
    const words = serviceHealthWords(health, t);
    expect(words.label).toBe("1 of 2 ready");
    expect(words.role).toBe("warn");
    expect(words.reason).toBe("1 draining");
  });

  /**
   * deny-all-ingress over two ready pods: the slices count them whole and
   * Traefik answers 502. Fails if the counts win over the shut door, which
   * paints the Services list, the peek and the Overview green.
   */
  it("calls a Service whose ready pods a policy shuts shut, in red, naming the policy", () => {
    const stop: ChainStop = {
      reason: "policyRefuses",
      service: SERVICE,
      policies: ["deny-all-ingress"],
      ports: [8080],
      noRules: true,
      client: null,
    };
    const health = serviceHealthOf(
      SELECTING,
      published({ ready: 2, stop }),
      null
    );
    expect(health.state).toBe("shut");
    expect(serviceHealthWords(health, t)).toMatchObject({
      role: "err",
      label: "shut by NetworkPolicy",
      reason:
        "NetworkPolicy deny-all-ingress admits no connection to these pods",
    });
    expect(
      describeStop({ ...stop, noRules: false, policies: ["a", "b"] }, t).title
    ).toBe("NetworkPolicies a, b admit nothing on port 8080");
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
   * Dana's manual-demo, two hand-written addresses no pod owns, read a green
   * "2 ready" with nothing probed. Fails if a Service with no selector whose
   * addresses say ready is called ready in the ok tone, or stops saying the
   * addresses were written by hand and never probed, or which are not ready.
   */
  it("says a selectorless Service's ready addresses were written by hand, in no healthy tone", () => {
    const manual = { type: "ClusterIP", selectorless: true };
    const health = serviceHealthOf(manual, published({ ready: 2 }), null);
    expect(health).toEqual({ state: "byHand", ready: 2, total: 2 });
    const words = serviceHealthWords(health, t);
    expect(words).toMatchObject({ role: "neutral", label: "2 by hand" });
    expect(words.reason).toBe(
      "This Service has no selector: its 2 addresses were written by hand or by another controller, not picked from pods this app can see, and nothing here probed them."
    );
    expect(
      serviceHealthWords(
        serviceHealthOf(manual, published({ ready: 1, notReady: 1 }), null),
        t
      ).reason
    ).toMatch(/ 1 of them is marked not ready\.$/);
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
          cause: null,
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
   * Sam's big-pull read red "No pod carries app=big-pull" for a tenth of a
   * second from a read that listed the pods just before its Deployment made
   * the first. Fails if a workload making its pods leaves the Service a
   * fault, on its badge or on its chain.
   */
  it("reads coming up, not no endpoints, while its workload is making its pods", () => {
    const stop = {
      reason: "podsBeingMade" as const,
      service: SERVICE,
      selector: "app=big-pull",
      workloads: [{ ...SERVICE, kind: "Deployment", name: "big-pull" }],
    };
    const health = serviceHealthOf(SELECTING, published({ stop }), null);
    expect(health.state).toBe("comingUp");
    const words = serviceHealthWords(health, t);
    expect(words.label).toBe("coming up");
    expect(words.role).toBe("pending");
    expect(words.reason).toBe(
      "No pod carries app=big-pull yet: big-pull is making its pods"
    );
    expect(chainStopHop(stop, SERVICE, t)).toMatchObject({ mood: "coming" });
  });

  /**
   * A Service in front of root-web, whose pods Pod Security refuses, said
   * no pod carries app=root-web and that nothing is behind it. Fails if the
   * refusal is not the reason on its row and its chain, names no workload,
   * or reads as anything but a fault.
   */
  it("says the API server refuses its workload's pods, not that no pod carries its selector", () => {
    const stop = {
      reason: "podsRefused" as const,
      service: SERVICE,
      selector: "app=root-web",
      workloads: [{ ...SERVICE, kind: "Deployment", name: "root-web" }],
      said: 'pods "root-web-7d9-x" is forbidden: violates PodSecurity "restricted:latest": allowPrivilegeEscalation != false (container "app" must set securityContext.allowPrivilegeEscalation=false), runAsNonRoot != true (pod or container "app" must set securityContext.runAsNonRoot=true)',
    };
    const health = serviceHealthOf(SELECTING, published({ stop }), null);
    expect(health.state).toBe("noEndpoints");
    const words = serviceHealthWords(health, t);
    expect(words.role).toBe("err");
    expect(words.reason).toBe(
      "Pod Security restricted refuses its pods: 2 checks fail"
    );
    expect(chainStopHop(stop, SERVICE, t)).toMatchObject({
      mood: "fault",
      title: "Pod Security restricted refuses its pods: 2 checks fail",
      note: "No pod carries app=root-web: the API server will not create the pods of Deployment root-web, so connections to this address are refused. Open Deployment root-web for why and what to change.",
    });
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

  /**
   * Sam's big-pull: its pod pulling an image had no address yet, so the
   * slices listed none and the Services list, Needs attention and the page
   * Status read red no endpoints above a blue "coming up" traffic block.
   * Fails if a Service with nothing listed is drawn as a fault while its
   * workload is coming up or its pods were not read, or if one behind no
   * workload at all is let off.
   */
  it("reads a Service with no address yet by what its workload waits on", () => {
    const empty = (stop: ServicePublished["stop"]) =>
      serviceHealthOf(SELECTING, published({ stop }), null);
    const coming = empty({
      reason: "noneReady",
      service: SERVICE,
      selector: "app=big-pull",
      pods: 1,
      why: "comingUp",
      cause: null,
    });
    expect(coming.state).toBe("comingUp");
    const comingWords = serviceHealthWords(coming, t);
    expect(comingWords.label).toBe("coming up");
    expect(comingWords.role).toBe("pending");

    const unread = empty({
      reason: "publishesNothingYet",
      service: SERVICE,
      selector: "app=ledger",
      podsUnread: true,
    });
    expect(unread.state).toBe("podsUnread");
    const unreadWords = serviceHealthWords(unread, t);
    expect(unreadWords.label).toBe("no endpoints");
    expect(unreadWords.role).toBe("neutral");
    expect(unreadWords.glyph).toBe(EyeOff);
    expect(unreadWords.reason).toBe(
      "Nothing is published behind app=ledger yet: pods not read, so whether they are starting is not known"
    );

    const nobody = empty({
      reason: "publishesNothingYet",
      service: SERVICE,
      selector: "app=ledger",
      podsUnread: false,
    });
    expect(nobody.state).toBe("noEndpoints");
    expect(serviceHealthWords(nobody, t).role).toBe("err");
  });
});

describe("a Service none of whose pods is ready", () => {
  const exits: SharedCause = {
    cause: {
      says: "exits",
      container: "web",
      restarts: 6,
      run: {
        code: 1,
        signal: null,
        reason: "Error",
        started: null,
        ended: null,
        previous: true,
        said: "Error: DATABASE_URL is not set",
        log: { says: "notRead" },
        limit: null,
      },
      until: null,
    },
    pods: 2,
    of: 2,
  };
  const failing = (why: NotServing) =>
    serviceHealthWords(
      serviceHealthOf(
        SELECTING,
        published({
          notReady: 2,
          stop: {
            reason: "noneReady",
            service: SERVICE,
            selector: "app=web",
            pods: 2,
            why,
            cause: exits,
          },
        }),
        null
      ),
      t
    );

  /**
   * crash-demo's Service said "none ready: the pods are crash looping" and
   * sent the reader to their logs. Fails if the cause its pods share stops
   * following the verdict, here and in the chain's note.
   */
  it("follows its verdict with the cause its pods share", () => {
    expect(failing("crashLooping").reason).toContain(
      "2 of 2 pods: web exited (exit 1, Error). Its exit message: Error: DATABASE_URL is not set"
    );
    const stop = published({
      stop: {
        reason: "noneReady",
        service: SERVICE,
        selector: "app=web",
        pods: 2,
        why: "crashLooping",
        cause: exits,
      },
    }).stop!;
    expect(describeStop(stop, t).note).toContain("2 of 2 pods: web exited");
  });

  /** Fails if pods still coming up, or never read, are said to have a cause. */
  it("tells no cause for pods still coming up or not read", () => {
    expect(failing("comingUp").reason).not.toContain("web exited");
    expect(failing("podsUnread").reason).not.toContain("web exited");
  });
});
