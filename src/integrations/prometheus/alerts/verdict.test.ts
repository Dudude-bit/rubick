import { describe, expect, it } from "vitest";

import { translate } from "@/i18n";
import type { CustomResourceInfo, NamespaceInfo } from "@/generated/types";
import {
  readPrometheus,
  type Kind,
  type PrometheusInstance,
  type Read,
} from "../monitors/model";
import { readRule, rowsOf } from "./model";
import { rowWords } from "./words";
import { verdictOf } from "./verdict";

const t = ((
  section: never,
  key: never,
  values?: Record<string, string | number>
) => translate("en", section, key, values)) as never;

const cr = (
  kind: string,
  name: string,
  namespace: string,
  spec: unknown
): CustomResourceInfo =>
  ({
    name,
    namespace,
    uid: `${namespace}/${kind}/${name}`,
    apiVersion: "monitoring.coreos.com/v1",
    kind,
    spec,
    status: null,
    labels: {},
    annotations: {},
    createdAt: null,
    ownerReferences: [],
    generation: 1,
  }) as CustomResourceInfo;

const object = readRule(
  cr("PrometheusRule", "apps", "monitoring", {
    groups: [
      {
        name: "kubernetes-apps",
        rules: [{ alert: "KubePodCrashLooping", expr: "up == 0", for: "15m" }],
      },
    ],
  })
);

const prometheus = readPrometheus(
  cr("Prometheus", "k8s", "monitoring", {
    ruleSelector: {},
    ruleNamespaceSelector: {},
  })
);

const instances = (items: PrometheusInstance[]): Kind<PrometheusInstance> => ({
  state: "read",
  items,
});

const namespaces: Read<NamespaceInfo> = { ok: true, items: [] };

const row = (read: Parameters<typeof rowsOf>[3]) =>
  rowsOf([object], instances([prometheus]), namespaces, read)[0];

describe("the sentence the Alerts card leads with", () => {
  /**
   * The two arms that keep an unread Prometheus from getting the quiet
   * verdict. Inside the page component they were reachable by no test, and
   * both could be deleted with the whole suite green — so "nothing to do
   * here" would be printed about rules nobody has read.
   */
  it("does not give the quiet verdict to a Prometheus that was never asked", () => {
    const notConnected = verdictOf(row({ state: "notConnected" }), 1, t);
    expect(notConnected.head).not.toBe(
      translate("en", "alerts", "verdictQuiet", { n: 1 })
    );

    const unanswered = verdictOf(
      row({ state: "unanswered", reason: "connection refused" }),
      1,
      t
    );
    expect(unanswered.body).toContain("connection refused");
  });

  /** And the quiet verdict still arrives when the reading was done. */
  it("says there is nothing to do when the rules were read and are quiet", () => {
    const quiet = verdictOf(
      row({
        state: "read",
        rules: [
          {
            group: "kubernetes-apps",
            // `<namespace>-<name>.yaml` is what the operator writes, and
            // what `ownsFile` matches on.
            file: "/etc/prometheus/rules/prometheus-kps-rulefiles-0/monitoring-apps.yaml",
            name: "KubePodCrashLooping",
            state: "inactive",
            health: "ok",
            lastError: "",
            query: "up == 0",
            durationSeconds: 900,
            lastEvaluation: null,
            labels: {},
            annotations: {},
            alerts: [],
          },
        ],
      }),
      1,
      t
    );
    expect(quiet.body).toBe(translate("en", "monitors", "nothingToDo"));
  });
});

describe("the row's own few words", () => {
  /**
   * A row whose rules nobody has read is not a quiet row, and the rule that
   * says so had no test: deleting it made an unchecked row read "quiet".
   */
  it("does not call an unread row a quiet one", () => {
    expect(rowWords(row({ state: "notConnected" }), t)).toBe(
      translate("en", "monitors", "rowNotChecked")
    );
  });
});
