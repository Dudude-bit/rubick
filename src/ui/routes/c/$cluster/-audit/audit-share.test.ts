import { describe, expect, it } from "vite-plus/test";

import type { AuditPage } from "@/generated/types";
import { translate } from "@/i18n";
import type { T } from "@/i18n/useT";
import { auditObjectSection, auditScreenSection } from "./audit-share";

const t: T = (section, key, values) => translate("en", section, key, values);

const page: AuditPage = {
  revision: 3,
  summary: {
    findings: 1,
    severities: { high: 1, medium: 0, low: 0 },
    categories: { security: 1, reliability: 0, efficiency: 0, upgrade: 0 },
    rules: [],
    checked: [{ kind: "Deployment", objects: 2 }],
    notChecked: [
      {
        kind: "ConfigMap",
        namespace: "shop",
        why: { says: "refused", message: "forbidden" },
        rules: ["config-map-private-key"],
      },
    ],
    late: [],
    system: { namespaces: [], objects: 0, findings: 0 },
    reading: 0,
    unattributed: 0,
    enforced: [],
    upgrade: { read: "2026-11-14T10:00:00Z", server: "v1.31.4" },
    usage: null,
  },
  rows: [
    {
      row: "rule",
      rule: "pss-privileged",
      worst: "high",
      objects: 1,
      unchecked: 0,
    },
  ],
  total: 1,
  next: null,
};

describe("Audit in a shared file", () => {
  /**
   * The file is read without the screen. Fails if a kind the screen says it
   * could not read is missing from the file, or the file states a total it
   * does not have.
   */
  it("carries what was not read, and no total over a scope it could not read whole", () => {
    const section = auditScreenSection(page, "rule", t);
    expect(section.count).toBeNull();
    expect(section.partial).toContain("ConfigMap in shop: refused: forbidden");
    expect(section.notRead).toEqual(["ConfigMap in shop: refused: forbidden"]);
    expect(section.body).toMatchObject({
      type: "findings",
      items: [{ title: "High · Runs a privileged container", role: "err" }],
    });
  });

  /**
   * A Helm release is named in words in the file, as on screen, and a scope
   * whose upgrade rules are still reading is not written as whole. Fails if
   * the file named a release by its internal kind, or counted a total
   * before the releases were read.
   */
  it("names a release in words and keeps an unread upgrade pass out of the total", () => {
    const section = auditScreenSection(
      {
        ...page,
        summary: {
          ...page.summary,
          notChecked: [],
          upgrade: { read: null, server: null },
        },
        rows: [
          {
            row: "found",
            subject: {
              kind: "HelmRelease.helm.sh",
              namespace: "shop",
              name: "web",
            },
            finding: {
              rule: "removed-api-in-helm-release",
              severity: "high",
              what: [{ says: "revision", revision: 2, status: "deployed" }],
            },
          },
        ],
      },
      "rule",
      t
    );
    expect(section.count).toBeNull();
    expect(section.notRead).toEqual([
      "Upgrade: still reading Helm releases, and who writes through versions a later Kubernetes removes",
    ]);
    expect(section.body).toMatchObject({
      type: "findings",
      items: [{ ref: { kind: "Helm release", stem: expect.any(String) } }],
    });
  });

  /**
   * Requests not weighed against use make the file partial, saying why.
   * Fails if a file written without a Prometheus read as a whole answer.
   */
  it("keeps requests not weighed against use out of the total", () => {
    const section = auditScreenSection(
      {
        ...page,
        summary: {
          ...page.summary,
          notChecked: [],
          usage: { says: "noSupplier" },
        },
      },
      "rule",
      t
    );
    expect(section.count).toBeNull();
    expect(section.notRead).toEqual([
      "Requests against use: not weighed, since no Prometheus is connected to this cluster",
    ]);
  });

  /** Fails if an object's unanswered rule reaches the file as a pass. */
  it("writes an object's unanswered rules as not read", () => {
    const section = auditObjectSection(
      {
        subject: { kind: "Deployment", namespace: "shop", name: "web" },
        system: false,
        findings: [],
        unchecked: [
          {
            rule: "no-disruption-budget",
            kind: "PodDisruptionBudget",
            namespace: "shop",
            why: { says: "refused", message: "forbidden" },
          },
        ],
        judgedOn: null,
      },
      null,
      t
    );
    expect(section.count).toBeNull();
    expect(section.body).toMatchObject({
      type: "findings",
      items: [{ mark: "notRead", title: "No PodDisruptionBudget" }],
    });
  });
});
