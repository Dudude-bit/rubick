import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vite-plus/test";

import type {
  ChainStop,
  GatewayInfo,
  ListenerSetInfo,
  ObjectRef,
} from "@/generated/types";
import { translate } from "@/i18n";
import type { T } from "@/i18n/useT";
import { describeStop } from "./connections";
import { parentAt, parentWords, type ParentGap } from "./parent-at";

const t: T = (section, key, values) => translate("en", section, key, values);

interface Named {
  name: string;
  namespace: string;
}
interface Case {
  name: string;
  routeNamespace: string;
  parent: { kind?: string; name: string; namespace?: string };
  gateways: (Named & { listenerSets?: Named[] })[] | null;
  sets: (Named & { gateway: Named })[] | null;
  at: {
    state: string;
    kind: string;
    name: string;
    namespace: string;
    via: Named | null;
  };
}

const corpus = JSON.parse(
  readFileSync(
    resolve(process.cwd(), "src/contracts/parent-resolution-conformance.json"),
    "utf8"
  )
) as { cases: Case[] };

const gatewayOf = (named: Named & { listenerSets?: Named[] }) =>
  ({
    name: named.name,
    namespace: named.namespace,
    listenerSets: named.listenerSets ?? [],
  }) as GatewayInfo;

const setOf = (set: Named & { gateway: Named }) =>
  ({
    name: set.name,
    namespace: set.namespace,
    gatewayName: set.gateway.name,
    gatewayNamespace: set.gateway.namespace,
  }) as ListenerSetInfo;

describe("where a route's parentRef leads", () => {
  /**
   * The Routes trace and the Connections chain resolve one parentRef; a
   * case one side answers differently is two screens naming different
   * objects missing for one route.
   */
  it("resolves every parent as the shared corpus says", () => {
    expect(corpus.cases.length).toBeGreaterThan(8);
    for (const each of corpus.cases) {
      const at = parentAt(
        {
          kind: each.parent.kind ?? "Gateway",
          name: each.parent.name,
          namespace: each.parent.namespace ?? null,
        },
        each.routeNamespace,
        each.gateways?.map(gatewayOf) ?? null,
        each.sets?.map(setOf) ?? null
      );
      const named =
        at.state === "found"
          ? {
              kind: "Gateway",
              name: at.gateway.name,
              namespace: at.gateway.namespace,
            }
          : { kind: at.kind, name: at.name, namespace: at.namespace };
      expect({ state: at.state, ...named, via: at.via }, each.name).toEqual(
        each.at
      );
    }
  });

  /**
   * "Gateway app-tls does not exist" was said of a ListenerSet that was
   * there, whose Gateway was the one gone. Fails if a gap is not worded as
   * the object that is not there, or a list not read reads as a missing
   * object rather than one nobody could look for.
   */
  it("words what is not there behind a parent, and what could not be looked for", () => {
    const gap = (over: Partial<ParentGap>): ParentGap => ({
      state: "missing",
      kind: "Gateway",
      name: "edge",
      namespace: "infra",
      via: null,
      ...over,
    });
    const team = { name: "team", namespace: "shop" };
    expect(parentWords(gap({}), t).say).toBe(
      "Gateway edge does not exist in infra"
    );
    expect(parentWords(gap({ via: team }), t).say).toBe(
      "ListenerSet team names Gateway edge, which does not exist in infra"
    );
    expect(
      parentWords(
        gap({ kind: "ListenerSet", name: "team", namespace: "shop" }),
        t
      ).say
    ).toBe("ListenerSet team does not exist in shop");
    const unread = parentWords(
      gap({ state: "unread", kind: "ListenerSet", name: "team" }),
      t,
      "listenersets is forbidden"
    );
    expect(unread.say).toBe("Cannot tell which Gateway team belongs to");
    expect(unread.detail?.body).toContain(
      "The cluster said: listenersets is forbidden"
    );
    expect(parentWords(gap({ state: "unread", via: team }), t).say).toBe(
      "Gateway edge: cannot be read from here"
    );
  });

  /**
   * The chain said a set's missing Gateway in words of its own, beside a
   * trace that said it in others. Fails if the chain's stop is not worded
   * by the same function as the trace's step.
   */
  it("words the chain's stop as the trace words its step", () => {
    const ref = (kind: string, name: string, namespace: string): ObjectRef =>
      ({ kind, name, namespace, existence: "missing" }) as ObjectRef;
    const stop: ChainStop = {
      reason: "gatewayMissing",
      route: ref("HTTPRoute", "promo", "shop"),
      gateway: ref("Gateway", "edge", "infra"),
      listenerSet: { name: "team", namespace: "shop" },
    };
    const words = parentWords(
      {
        state: "missing",
        kind: "Gateway",
        name: "edge",
        namespace: "infra",
        via: { name: "team", namespace: "shop" },
      },
      t
    );
    const said = describeStop(stop, t);
    expect(said.title).toBe(words.detail?.title);
    expect(said.note.startsWith(words.say)).toBe(true);
    expect(
      describeStop(
        {
          ...stop,
          gateway: ref("ListenerSet", "team", "shop"),
          listenerSet: null,
        },
        t
      ).note
    ).toContain("ListenerSet team does not exist in shop");
  });
});
