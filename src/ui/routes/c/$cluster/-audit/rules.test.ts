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
];

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
