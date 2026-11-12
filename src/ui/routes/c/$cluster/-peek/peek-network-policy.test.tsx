import { describe, expect, it } from "vite-plus/test";
import { renderWithRouter } from "@/test/render";

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
  uid: "",
  name: "p",
  namespace: "shop",
  selects: { kind: "everything" },
  selected: 3,
  nearly: null,
  ingress: direction({}),
  egress: direction({ governed: false }),
  labels: {},
  createdAt: null,
  ...over,
});

const summary = (info: NetworkPolicyInfo) =>
  resolveSource({
    kind: "NetworkPolicy",
    name: "p",
    namespace: "shop",
  }).summarise(
    info,
    { kind: "NetworkPolicy", name: "p", namespace: "shop" },
    say
  );

const summarise = (info: NetworkPolicyInfo) => summary(info).groups;

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
    expect(ingress.emptyMessage).toBe("doesNotRestrict");
  });

  /**
   * The same three answers the list gives, said the same way: a refused pod
   * list is `None`, not zero, and zero is the finding the page exists for.
   * The words differed and the colour did not, so "pods not read" was
   * painted as a count the peek had.
   */
  it("keeps a pod list nobody could read apart from an empty one", async () => {
    const drawn = async (selected: number | null) => {
      const { container, unmount } = await renderWithRouter(
        <>{summarise(policy({ selected }))[0].items[1].value}</>
      );
      const out = {
        text: container.textContent,
        colour: container.querySelector("span, a")?.className ?? "",
      };
      unmount();
      return out;
    };
    const refused = await drawn(null);
    const empty = await drawn(0);
    const some = await drawn(3);

    expect(refused.colour).not.toBe(some.colour);
    expect(refused.colour).not.toBe(empty.colour);
    expect(refused.text).toBe("pods not read");
    expect(empty.text).toBe("no pods");
    expect(summarise(policy({ selected: 0 }))[0].items[1].tone).toBe("warn");
  });

  /**
   * The panel said "no pods" under a misspelled selector and left the reader
   * to find the typo. Fails if the peek stops leading with the cause the page
   * leads with, or claims it where the pods were never read.
   */
  it("leads with the label its pods carry where it selects none", async () => {
    const typo = policy({
      selects: { kind: "written", query: "app=cloud-dmeo" },
      selected: 0,
      nearly: { asked: "app=cloud-dmeo", carried: "app=cloud-demo", pods: 2 },
    });
    const { container } = await renderWithRouter(<>{summary(typo).lead}</>);
    expect(container.textContent).toBe(
      "policyRestrictsNothingpolicyNearLabel:2"
    );
    expect(summary({ ...typo, selected: null }).lead).toBeFalsy();
    expect(summary({ ...typo, selected: 2 }).lead).toBeFalsy();
  });
});
