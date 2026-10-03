import { describe, expect, it } from "vitest";

import { translate } from "@/i18n";
import type { T } from "@/i18n/useT";

import { reportOf } from "./report";

const t: T = (section, key, values) => translate("en", section, key, values);

describe("what a Kustomization tells a reader with no cluster access", () => {
  it("names its source, what it applied and that it is ready", () => {
    const sections = reportOf(
      {
        group: "kustomize.toolkit.fluxcd.io",
        kind: "Kustomization",
        namespace: "flux-system",
        name: "apps",
        spec: {
          path: "./clusters/prod",
          sourceRef: { kind: "GitRepository", name: "flux-system" },
        },
        status: {
          conditions: [{ type: "Ready", status: "True" }],
          lastAppliedRevision: "main@sha1:abc1234def",
        },
      },
      t
    );
    expect(sections).toHaveLength(1);
    const rows =
      sections?.[0]?.body.type === "facts" ? sections[0].body.rows : [];
    expect(rows[0]).toEqual({
      label: "Status",
      values: [{ text: "ready", role: "ok" }],
    });
    expect(rows.find((row) => row.label === "Source")?.values[0]?.text).toBe(
      "GitRepository/flux-system"
    );
    expect(rows.find((row) => row.label === "Applied")?.values[0]?.text).toBe(
      "main@abc1234"
    );
  });

  it("does not claim the source is missing: this report never saw it", () => {
    const sections = reportOf(
      {
        group: "kustomize.toolkit.fluxcd.io",
        kind: "Kustomization",
        namespace: "flux-system",
        name: "apps",
        spec: { sourceRef: { kind: "GitRepository", name: "flux-system" } },
        status: {
          conditions: [{ type: "Ready", status: "False", reason: "Failed" }],
        },
      },
      t
    );
    const rows =
      sections?.[0]?.body.type === "facts" ? sections[0].body.rows : [];
    expect(rows.find((row) => row.label === "Message")).toBeUndefined();
    expect(
      sections?.[0]?.body.type === "facts"
        ? sections[0].body.rows[0]?.values[0]?.text
        : ""
    ).toBe("not ready");
  });
});

describe("what a GitRepository tells a reader with no cluster access", () => {
  it("names what it tracks and its last artifact", () => {
    const sections = reportOf(
      {
        group: "source.toolkit.fluxcd.io",
        kind: "GitRepository",
        namespace: "flux-system",
        name: "flux-system",
        spec: {
          url: "https://git.example.com/acme/fleet",
          ref: { branch: "main" },
        },
        status: {
          conditions: [{ type: "Ready", status: "True" }],
          artifact: { revision: "main@sha1:abc1234def" },
        },
      },
      t
    );
    const rows =
      sections?.[0]?.body.type === "facts" ? sections[0].body.rows : [];
    expect(rows.find((row) => row.label === "URL")?.values[0]?.text).toBe(
      "https://git.example.com/acme/fleet"
    );
    expect(rows.find((row) => row.label === "Tracking")?.values[0]?.text).toBe(
      "main"
    );
  });
});

describe("what an object of another vendor's kind gets", () => {
  it("declines an Application: that is Argo CD's kind, not Flux's", () => {
    const sections = reportOf(
      {
        group: "argoproj.io",
        kind: "Application",
        namespace: "argocd",
        name: "storefront",
        spec: {},
        status: {},
      },
      t
    );
    expect(sections).toBeNull();
  });
});
