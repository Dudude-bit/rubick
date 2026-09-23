import { describe, expect, it } from "vitest";

import type { CustomResourceInfo, ServiceInfo } from "@/generated/types";
import { translate } from "@/i18n";
import { verdictOf } from "./verdict";
import {
  readMonitor,
  readPrometheus,
  rowsOf,
  type Kind,
  type PrometheusInstance,
  type Read,
  type TargetsRead,
} from "./model";

const t = ((
  section: never,
  key: never,
  values?: Record<string, string | number>
) => translate("en", section, key, values)) as never;

const cr = (
  kind: string,
  name: string,
  namespace: string,
  spec: unknown,
  labels: Record<string, string> = {}
): CustomResourceInfo => ({
  name,
  namespace,
  uid: `${namespace}/${kind}/${name}`,
  apiVersion: "monitoring.coreos.com/v1",
  kind,
  spec,
  status: null,
  labels,
  annotations: {},
  createdAt: null,
  ownerReferences: [],
  generation: 1,
});

const ok = <T>(items: T[]): Read<T> => ({ ok: true, items });
const kindOf = (items: PrometheusInstance[]): Kind<PrometheusInstance> => ({
  state: "read",
  items,
});

const service = (name: string, namespace: string): ServiceInfo =>
  ({
    name,
    namespace,
    uid: `${namespace}/${name}`,
    labels: { app: name },
  }) as unknown as ServiceInfo;

const monitor = () =>
  readMonitor(
    cr(
      "ServiceMonitor",
      "web",
      "shop",
      {
        selector: { matchLabels: { app: "web" } },
        endpoints: [{ port: "http" }],
      },
      { release: "kps" }
    ),
    "ServiceMonitor"
  );

const prometheus = () =>
  readPrometheus(
    cr("Prometheus", "k8s", "shop", { serviceMonitorSelector: {} })
  );

const rowWith = (targets: TargetsRead) =>
  rowsOf(
    [monitor()],
    kindOf([prometheus()]),
    ok([service("web", "shop")]),
    ok([]),
    targets
  )[0];

describe("the sentence the monitor card leads with", () => {
  /**
   * A selector Kubernetes would refuse to build has no arm to fall past:
   * without one the card led with whatever the scrape said, over a
   * selector nobody can say anything about.
   */
  it("leads with a selector that cannot be evaluated", () => {
    const odd = readMonitor(
      cr("ServiceMonitor", "web", "shop", {
        selector: { matchExpressions: [{ key: "app", operator: "Near" }] },
        endpoints: [{ port: "http" }],
      }),
      "ServiceMonitor"
    );
    const [row] = rowsOf(
      [odd],
      kindOf([prometheus()]),
      ok([service("web", "shop")]),
      ok([]),
      { state: "notConnected" }
    );
    const verdict = verdictOf(row, 1, null, null, t);
    expect(verdict.head).toBe(
      translate("en", "monitors", "verdictSelectorUnevaluable")
    );
    expect(verdict.body).toContain("app Near ()");
  });

  /**
   * A target Prometheus has discovered and not yet scraped reports health
   * "unknown". The model says so — `targetsUnscraped` — and the card had no
   * arm for it, so the row fell past the switch and past both scrape guards
   * onto "{n} targets up, scraped {ago} ago" and "Nothing to do here": a
   * flat all-clear over the table beside it reading "1 of 1 discovered, not
   * scraped yet", and an `ago` rendered as the literal "?".
   */
  it("does not say there is nothing to do about targets nobody has scraped", () => {
    const row = rowWith({
      state: "read",
      targets: [
        {
          scrapePool: "serviceMonitor/shop/web/0",
          scrapeUrl: "http://a",
          health: "unknown",
          lastError: "",
          lastScrape: null,
          labels: {},
        },
      ],
    });

    expect(row.findings.map((f) => f.kind)).toEqual(["targetsUnscraped"]);
    const verdict = verdictOf(row, 1, null, null, t);
    expect(verdict.head).toContain("not scraped yet");
    expect(verdict.head).not.toContain("up, scraped");
    expect(verdict.body).not.toBe(translate("en", "monitors", "nothingToDo"));
  });

  /**
   * And the case the fall-through was written for still reads as it did:
   * scraped targets, all up, nothing to do.
   */
  it("still says there is nothing to do when every target is up", () => {
    const row = rowWith({
      state: "read",
      targets: [
        {
          scrapePool: "serviceMonitor/shop/web/0",
          scrapeUrl: "http://a",
          health: "up",
          lastError: "",
          lastScrape: "2026-09-20T18:00:00Z",
          labels: {},
        },
      ],
    });

    expect(row.findings).toEqual([]);
    const verdict = verdictOf(row, 1, null, "2m", t);
    expect(verdict.head).toContain("up, scraped");
    expect(verdict.body).toBe(translate("en", "monitors", "nothingToDo"));
  });
});
