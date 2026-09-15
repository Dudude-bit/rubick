import { describe, expect, it } from "vitest";

import type { NetworkPolicyInfo, PolicyDirection } from "@/generated/types";
import { resolveSource } from "./peek-sources";

const say = ((_section: string, key: string, values?: { n?: number }) =>
  values?.n === undefined ? key : `${key}:${values.n}`) as never;

const direction = (over: Partial<PolicyDirection>): PolicyDirection => ({
  governed: true,
  rules: [],
  opensToEverything: false,
  deniesEverything: false,
  ...over,
});

const policy = (over: Partial<NetworkPolicyInfo>): NetworkPolicyInfo => ({
  name: "p",
  namespace: "shop",
  selects: { kind: "everything" },
  selected: 3,
  ingress: direction({}),
  egress: direction({ governed: false }),
  labels: {},
  createdAt: null,
  ...over,
});

const summarise = (info: NetworkPolicyInfo) =>
  resolveSource({
    kind: "NetworkPolicy",
    name: "p",
    namespace: "shop",
  }).summarise(
    info,
    { kind: "NetworkPolicy", name: "p", namespace: "shop" },
    say
  ).groups;

describe("the NetworkPolicy the peek panel draws", () => {
  /**
   * Without an entry of its own the panel fell through to the generic
   * manifest walker, which flattens `ingress.0.from.0.namespaceSelector`
   * into a dotted path and loses the AND between a peer's two selectors.
   * Fails if the kind stops having a source here.
   */
  it("is read by its own source and not by the manifest walker", () => {
    const groups = summarise(policy({}));
    expect(groups.map((g) => g.title)).toEqual([
      "selector",
      "Ingress",
      "Egress",
    ]);
  });

  /**
   * The object keeps the rules of a direction `policyTypes` does not name,
   * and the panel drew them — telling a reader ingress was restricted to
   * those peers while the list row said the policy makes no claim about it
   * and the detail page omitted the direction entirely. Ingress was in fact
   * wide open. Fails if the panel draws an ungoverned direction's rules.
   */
  it("draws no rules for a direction the policy does not govern", () => {
    const groups = summarise(
      policy({
        ingress: direction({
          governed: false,
          rules: [
            {
              peers: [
                {
                  pods: { kind: "written", query: "app=web" },
                  namespaces: { kind: "notSaid" },
                  ipBlock: null,
                },
              ],
              ports: [],
            },
          ],
        }),
      })
    );
    const ingress = groups.find((g) => g.title === "Ingress")!;
    expect(ingress.items).toEqual([]);
    expect(ingress.count).toBeUndefined();
    expect(ingress.emptyMessage).toBe("saysNothing");
  });

  /**
   * The same three answers the list gives, said the same way: a refused pod
   * list is `None`, not zero, and zero is the finding the page exists for.
   */
  it("keeps a pod list nobody could read apart from an empty one", () => {
    const refused = summarise(policy({ selected: null }))[0].items[1];
    expect(refused.value).toBe("podsNotRead");
    expect(refused.tone).toBeUndefined();

    const empty = summarise(policy({ selected: 0 }))[0].items[1];
    expect(empty.value).toBe("selectsNoPods");
    expect(empty.tone).toBe("warn");
  });
});
