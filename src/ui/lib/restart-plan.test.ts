import { describe, expect, it } from "vite-plus/test";

import { translate } from "@/i18n";
import type { T } from "@/i18n/useT";
import { restartWords } from "./restart-plan";

const t = ((_section: string, key: string, values?: Record<string, unknown>) =>
  values
    ? `${key}(${Object.entries(values)
        .map(([k, v]) => `${k}=${String(v)}`)
        .join(",")})`
    : key) as unknown as T;

describe("what a restart says it will do", () => {
  /** Dana's ask: the real numbers, so "3 pods, at most 1 unavailable and 1 extra" and not "the pods". */
  it("states a Deployment's pods and its resolved fenceposts", () => {
    expect(
      restartWords(
        { strategy: "rolling", replicas: 3, surge: 1, unavailable: 1 },
        "cart",
        t
      )
    ).toEqual({
      text: "restartPlanRolling(replaces=restartPods(n=3),unavailable=restartUnavailable(n=1),extra=restartExtra(n=1))",
      tone: "info",
    });
    expect(
      restartWords(
        { strategy: "rolling", replicas: 2, surge: 1, unavailable: 0 },
        "cart",
        t
      ).text
    ).toContain("unavailable=restartNoneUnavailable");
  });

  /** A Recreate Deployment is down for the whole restart, which a reader has to see before pressing. */
  it("warns that Recreate stops everything first", () => {
    expect(
      restartWords({ strategy: "recreate", replicas: 3 }, "api", t)
    ).toEqual({ text: "restartPlanRecreate(n=3)", tone: "warn" });
  });

  it("names the StatefulSet's pods in the order they go, down to the partition", () => {
    expect(
      restartWords(
        {
          strategy: "ordered",
          replicas: 3,
          start: 0,
          partition: 0,
          unavailable: 1,
        },
        "orders-db",
        t
      )
    ).toEqual({
      text: "restartPlanOrdered(replaces=restartPods(n=3),last=orders-db-2,first=orders-db-0)",
      tone: "info",
    });
    const held = restartWords(
      {
        strategy: "ordered",
        replicas: 3,
        start: 0,
        partition: 1,
        unavailable: 1,
      },
      "orders-db",
      t
    );
    expect(held.text).toContain("replaces=restartPods(n=2)");
    expect(held.text).toContain("first=orders-db-1");
    expect(held.text).toContain("restartPartitionHolds(partition=1)");
    expect(held.tone).toBe("warn");
    expect(
      restartWords(
        {
          strategy: "ordered",
          replicas: 3,
          start: 0,
          partition: 3,
          unavailable: 1,
        },
        "orders-db",
        t
      ).text
    ).toBe("restartPartitionHoldsAll(partition=3)");
  });

  /** Under OnDelete a restart changes the template and nothing else, so the dialog must not promise new pods. */
  it("says nothing restarts under OnDelete", () => {
    expect(
      restartWords({ strategy: "onDelete", replicas: 3 }, "orders-db", t)
    ).toEqual({ text: "restartPlanOnDelete", tone: "warn" });
  });

  it("goes node by node on a DaemonSet, and says surge where it surges", () => {
    expect(
      restartWords(
        { strategy: "nodes", nodes: 4, surge: 0, unavailable: 1 },
        "fluentd",
        t
      ).text
    ).toBe("restartPlanNodes(nodes=restartOfNodes(n=4),n=1)");
    expect(
      restartWords(
        { strategy: "nodes", nodes: 4, surge: 1, unavailable: 0 },
        "fluentd",
        t
      ).text
    ).toBe("restartPlanNodesSurge(nodes=restartOfNodes(n=4),n=1)");
  });

  /** A workload not read yet gets the general sentence, not a count of zero. */
  it("says the general case before the workload is read", () => {
    expect(restartWords(undefined, "cart", t).text).toBe("restartPlanUnknown");
  });

  /** The Russian read "Заменит 1 под; за раз недоступных нет, сверх нормы не больше 1.", every count but none of the nouns. */
  it("reads as a Russian sentence with the noun after each count", () => {
    const ru: T = (section, key, values) =>
      translate("ru", section, key, values);
    expect(
      restartWords(
        { strategy: "rolling", replicas: 1, surge: 1, unavailable: 0 },
        "hello-web",
        ru
      ).text
    ).toBe(
      "Заменит 1 под постепенно: все поды остаются доступными, сверх заданного числа реплик запускается не больше 1 пода."
    );
    expect(
      restartWords(
        { strategy: "rolling", replicas: 3, surge: 0, unavailable: 2 },
        "hello-web",
        ru
      ).text
    ).toBe(
      "Заменит 3 пода постепенно: одновременно недоступно не больше 2 подов, лишних подов не запускается."
    );
  });
});
