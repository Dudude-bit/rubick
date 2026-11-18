import { describe, expect, it } from "vite-plus/test";

import type { What, Why } from "@/generated/types";
import { translate } from "@/i18n";
import type { T } from "@/i18n/useT";
import { en } from "@/i18n/catalogue";
import { ru } from "@/i18n/ru";
import {
  RULE_IDS,
  RULE_META,
  RULE_WORDS,
  uncheckedWords,
  whatWords,
  whyWords,
} from "./rules";

const tIn =
  (locale: "en" | "ru"): T =>
  (section, key, values) =>
    translate(locale, section, key, values);

const at = { list: "initContainers" as const, container: "migrate" };
const refused: Why = { says: "refused", message: "forbidden" };

/** One of every value a finding can carry, so no variant goes unworded. */
const EVERY_WHAT: What[] = [
  { says: "set", at, field: "securityContext.privileged", value: "true" },
  { says: "set", at: null, field: "hostPID", value: "true" },
  { says: "unset", at, field: "readinessProbe" },
  { says: "volume", volume: "share", source: "nfs", path: null },
  { says: "volume", volume: "logs", source: "hostPath", path: "/var/log" },
  {
    says: "socket",
    volume: "docker",
    path: "/var/run",
    socket: "/var/run/docker.sock",
  },
  { says: "envLiteral", at, variable: "DB_PASSWORD" },
  { says: "key", key: "tls.key", net: { says: "keyName" } },
  { says: "key", key: "server.pem", net: { says: "privateKey" } },
  { says: "image", at, image: "nginx" },
  { says: "replicas", replicas: 1, autoscaler: null },
  { says: "replicas", replicas: 3, autoscaler: "web" },
  { says: "budget", required: 2, selected: 2 },
  { says: "token", by: "default" },
  { says: "token", by: "pod" },
  { says: "token", by: "account" },
  {
    says: "subject",
    kind: "ServiceAccount",
    name: "installer",
    namespace: "tools",
    role: "cluster-admin",
  },
  {
    says: "subject",
    kind: "User",
    name: "alice",
    namespace: null,
    role: "cluster-admin",
  },
  { says: "wildcard", groups: ["", "apps"] },
  { says: "range", min: 2, max: 2 },
  { says: "target", kind: "Deployment", name: "gone" },
  { says: "pods", pods: 4 },
  { says: "traffic", by: { says: "service", name: "web" } },
  { says: "traffic", by: { says: "noService" } },
  { says: "traffic", by: { says: "notRead", why: refused } },
  { says: "revision", revision: 4, status: "deployed" },
  {
    says: "stored",
    kind: "Ingress",
    name: "web",
    api: "extensions/v1beta1",
    served: false,
    removal: {
      removed: "1.22",
      replacement: "networking.k8s.io/v1",
      since: "1.19",
    },
  },
  {
    says: "stored",
    kind: "FlowSchema",
    name: "web",
    api: "flowcontrol.apiserver.k8s.io/v1beta3",
    served: true,
    removal: {
      removed: "1.32",
      replacement: "flowcontrol.apiserver.k8s.io/v1",
      since: "1.29",
    },
  },
  {
    says: "stored",
    kind: "Certificate",
    name: "web",
    api: "cert-manager.io/v1alpha2",
    served: false,
    removal: null,
  },
  {
    says: "written",
    manager: "ci",
    operation: "Update",
    time: "2026-11-01T10:00:00Z",
    api: "batch/v1beta1",
    removal: { removed: "1.25", replacement: "batch/v1", since: "1.21" },
  },
  {
    says: "written",
    manager: "ci",
    operation: "Apply",
    time: null,
    api: "policy/v1beta1",
    removal: { removed: "1.25", replacement: null, since: null },
  },
  {
    says: "deprecated",
    version: "v1alpha1",
    warning: "example.com/v1alpha1 CronTab is deprecated; use example.com/v1",
    stored: true,
    storage: false,
  },
  {
    says: "deprecated",
    version: "v1beta1",
    warning: null,
    stored: false,
    storage: false,
  },
  {
    says: "storedAs",
    group: "example.com",
    kind: "CronTab",
    storage: "v1",
    stored: ["v1alpha1", "v1"],
    current: ["v1"],
  },
  {
    says: "storedAs",
    group: "example.com",
    kind: "CronTab",
    storage: "v1",
    stored: [],
    current: ["v1"],
  },
  {
    says: "storedAs",
    group: "example.com",
    kind: "CronTab",
    storage: null,
    stored: ["v1"],
    current: ["v1"],
  },
  {
    says: "requested",
    kind: "Ingress",
    removed: "1.22",
    replacement: "networking.k8s.io/v1",
  },
  { says: "requested", kind: null, removed: null, replacement: null },
  { says: "requestedToday", requests: 14 },
  { says: "requestedToday", requests: 1 },
  { says: "requestedToday", requests: 0 },
  {
    says: "overRequested",
    resource: "cpu",
    requested: 2000,
    peak: 300,
    at_most: false,
  },
  {
    says: "overRequested",
    resource: "memory",
    requested: 4294967296,
    peak: 536870912,
    at_most: false,
  },
];

/** Every kind of value a finding carries: a new one fails to compile until it is listed. */
const SAYS: Record<What["says"], true> = {
  set: true,
  unset: true,
  volume: true,
  socket: true,
  envLiteral: true,
  key: true,
  image: true,
  replicas: true,
  budget: true,
  token: true,
  subject: true,
  wildcard: true,
  range: true,
  target: true,
  pods: true,
  traffic: true,
  revision: true,
  stored: true,
  written: true,
  deprecated: true,
  storedAs: true,
  requested: true,
  requestedToday: true,
  overRequested: true,
};

describe("the words Audit draws its rules and findings with", () => {
  /**
   * The table is total over the generated union, but the contract is a JSON
   * file nothing compiles. Fails when a rule is added to one and not the other.
   */
  it("names every rule the backend judges with, and no other", () => {
    expect([...RULE_IDS].sort()).toEqual(Object.keys(RULE_WORDS).sort());
    expect(Object.keys(RULE_META).sort()).toEqual([...RULE_IDS].sort());
  });

  /** Fails when a rule's title or why is left out of either language. */
  it("gives every rule a title and a why in both catalogues", () => {
    for (const rule of RULE_IDS) {
      const { title, why } = RULE_WORDS[rule];
      for (const catalogue of [en.audit, ru.audit]) {
        expect(catalogue[title], `${rule} title`).toBeTruthy();
        expect(catalogue[why], `${rule} why`).toBeTruthy();
      }
    }
  });

  /** Fails when a kind of value is added to the union and never worded here. */
  it("carries one of every kind of value a finding holds", () => {
    expect(new Set(EVERY_WHAT.map((what) => what.says))).toEqual(
      new Set(Object.keys(SAYS))
    );
  });

  /**
   * A stored version this cluster no longer serves, one it serves and a
   * later Kubernetes removes, and one the guide does not list that nothing
   * serves are three sentences. Fails if a version still served read as
   * already gone, or a gone one named no release.
   */
  it("tells a stored version already gone from one due to go", () => {
    const t = tIn("en");
    const [gone, due, unserved] = EVERY_WHAT.filter(
      (what) => what.says === "stored"
    );
    expect(whatWords(gone, t)).toBe(
      "Ingress web is stored as extensions/v1beta1, which Kubernetes 1.22 stopped serving"
    );
    expect(whatWords(due, t)).toBe(
      "FlowSchema web is stored as flowcontrol.apiserver.k8s.io/v1beta3, which Kubernetes 1.32 stops serving"
    );
    expect(whatWords(unserved, t)).toBe(
      "Certificate web is stored as cert-manager.io/v1alpha2, which this cluster does not serve"
    );
  });

  /**
   * Its why said the rest of a request was "used by nothing", and spare CPU
   * is borrowed by other pods' bursts: what a request takes from the node
   * is room to place another pod. Fails if the rule gives the wrong reason.
   */
  it("says a request keeps other pods off the node, not that the rest is idle", () => {
    const why = tIn("en")("audit", "requestsAboveUsageWhy");
    expect(why).toContain("no other pod can be placed on the rest");
    expect(why).not.toContain("used by nothing");
  });

  /**
   * A workload's peak is read per pod and summed: for several pods it is a
   * bound, and the finding says "no more than" rather than a peak it never
   * measured. Fails if a bound reads as the peak.
   */
  it("says a summed peak as a bound", () => {
    const t = tIn("en");
    expect(
      whatWords(
        {
          says: "overRequested",
          resource: "cpu",
          requested: 2000,
          peak: 300,
          at_most: true,
        },
        t
      )
    ).toBe(
      "CPU peaked at no more than 300m of the 2.0 it requests, over the last day"
    );
  });

  /**
   * A CRD's warning is its own words and reaches the page as written; a
   * count of requests that came back zero says none, and a count of one is
   * singular. Fails if the warning were reworded or a zero read as "0
   * requests".
   */
  it("keeps a CRD's warning as written and counts requests in words", () => {
    const t = tIn("en");
    const pick = <S extends What["says"]>(says: S) =>
      EVERY_WHAT.filter(
        (what): what is Extract<What, { says: S }> => what.says === says
      );
    const [warned, quiet] = pick("deprecated");
    expect(whatWords(warned, t)).toBe(
      "v1alpha1 is served and marked deprecated: example.com/v1alpha1 CronTab is deprecated; use example.com/v1"
    );
    expect(whatWords(quiet, t)).toBe(
      "v1beta1 is served and marked deprecated, with no warning of its own"
    );
    expect(pick("requestedToday").map((what) => whatWords(what, t))).toEqual([
      "14 requests in the last day",
      "1 request in the last day",
      "no request in the last day",
    ]);
    expect(whyWords({ says: "noPrometheus" }, t)).toMatch(
      /API server's own count of deprecated requests is read from one/
    );
  });

  /**
   * Two counts in one Russian phrase cannot both agree with one noun, so the
   * budget's witness names each with a colon. Fails if a budget of one pod
   * reads "требует 1 здоровых из 1 выбранных".
   */
  it("words a budget's two counts in Russian without a noun to agree with", () => {
    const t = tIn("ru");
    for (const [required, selected] of [
      [1, 1],
      [2, 3],
      [21, 25],
    ]) {
      expect(whatWords({ says: "budget", required, selected }, t)).toBe(
        `нужно здоровых: ${required}, выбрано: ${selected}`
      );
    }
  });

  /**
   * A placeholder with no value reaches the screen as `{name}`. Fails if any
   * value of any finding leaves one unfilled in either language.
   */
  it("fills every placeholder of every finding's sentence in both languages", () => {
    for (const locale of ["en", "ru"] as const) {
      const t = tIn(locale);
      for (const what of EVERY_WHAT) {
        const text = whatWords(what, t);
        expect(text, `${locale} ${JSON.stringify(what)}`).not.toMatch(/[{}]/);
        expect(text.length).toBeGreaterThan(5);
      }
    }
  });

  /**
   * Pods a webhook may change are named with the webhooks, in both
   * languages. Fails if the line drops which webhook it is.
   */
  it("names the webhooks pods pass on admission", () => {
    const why: Why = {
      says: "admitted",
      webhooks: ["sidecar-injector.istio.io", "linkerd-proxy-injector"],
    };
    expect(whyWords(why, tIn("en"))).toBe(
      "admitted through sidecar-injector.istio.io, linkerd-proxy-injector, which may add containers the template does not show"
    );
    expect(whyWords(why, tIn("ru"))).toContain("sidecar-injector.istio.io");
  });

  /** A refusal keeps the cluster's words, and an unread kind says where. */
  it("says why a rule went unanswered with the cluster's own words", () => {
    const t = tIn("en");
    expect(whyWords(refused, t)).toBe("refused: forbidden");
    expect(
      uncheckedWords(
        {
          rule: "no-disruption-budget",
          kind: "PodDisruptionBudget",
          namespace: "shop",
          why: refused,
        },
        t
      )
    ).toBe("PodDisruptionBudget in shop: refused: forbidden");
  });
});
