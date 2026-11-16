import { describe, expect, it } from "vite-plus/test";

import type { AuditPage } from "@/generated/types";
import { translate } from "@/i18n";
import type { T } from "@/i18n/useT";
import {
  auditObjectSection,
  auditScreenSection,
  filterWords,
} from "./audit-share";

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
   * A file of a filtered page holds only the filtered rows. Fails if it
   * does not say so, which reads three High rules as the cluster's findings.
   */
  it("says which filters narrowed the shared rows", () => {
    const narrowed = filterWords(
      {
        by: "rule",
        severities: ["high"],
        categories: ["security"],
        rules: [],
        system: false,
        offset: 0,
      },
      t
    );
    expect(narrowed).toBe("Only High, Security.");
    expect(auditScreenSection(page, "rule", t, narrowed).caption).toMatch(
      /^Only High, Security\. /
    );
    expect(
      filterWords(
        {
          by: "rule",
          severities: [],
          categories: [],
          rules: [],
          system: false,
          offset: 0,
        },
        t
      )
    ).toBeNull();
  });

  /**
   * Pods still being read and pods no workload claims are not judged. Fails
   * if the file drops them and states a whole total, where the screen warns.
   */
  it("says what is still being read or was not judged, with no total", () => {
    const section = auditScreenSection(
      {
        ...page,
        summary: {
          ...page.summary,
          notChecked: [],
          reading: 2,
          unattributed: 1,
        },
      },
      "rule",
      t
    );
    expect(section.count).toBeNull();
    expect(section.partial).toContain(
      "2 pods with no workload Audit reads are still being read"
    );
    expect(section.partial).toMatch(/^.*; .+$/);
    expect(section.notRead).toHaveLength(2);
  });

  /**
   * A rule row says how many objects it could not check, and one that only
   * could not check is filed as not read, not as a finding of its
   * severity. Fails if the file reads "High · … · 0 objects".
   */
  it("files a rule that only could not check as not read, and counts what was not checked", () => {
    const section = auditScreenSection(
      {
        ...page,
        rows: [
          {
            row: "rule",
            rule: "pss-privileged",
            worst: "high",
            objects: 1,
            unchecked: 2,
          },
          {
            row: "rule",
            rule: "autoscaler-target-missing",
            worst: null,
            objects: 0,
            unchecked: 1,
          },
        ],
      },
      "rule",
      t
    );
    expect(section.body).toMatchObject({
      type: "findings",
      items: [
        {
          title: "High · Runs a privileged container",
          detail: "1 object · 2 not checked",
          role: "err",
        },
        {
          title: "Autoscaler's target does not exist",
          detail: "1 not checked",
          role: "neutral",
          mark: "notRead",
        },
      ],
    });
  });

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

  /**
   * A pod a Deployment stamps out is judged on the Deployment, which may hold
   * high findings. Fails if its file shows an empty, clean list counted 0,
   * where the tab says only where it was judged.
   */
  it("says where a pod judged on its workload was judged, and counts nothing", () => {
    const section = auditObjectSection(
      {
        subject: { kind: "Pod", namespace: "shop", name: "web-7d9f-x" },
        system: false,
        findings: [],
        unchecked: [],
        judgedOn: { kind: "Deployment", namespace: "shop", name: "web" },
      },
      null,
      t
    );
    expect(section.count).toBeNull();
    expect(section.body).toEqual({
      type: "text",
      text: "This Pod's template is judged as part of Deployment web.",
    });
  });
});
