import { describe, expect, it } from "vitest";

import { translate } from "@/i18n";
import type { T } from "@/i18n/useT";

/** The tests read the English catalogue — the same strings as before. */
const t = ((section, key, values) =>
  translate("en", section, key, values)) as T;

import { policiesOnService, policyVerdict } from "./gateway-policies";
import type { BackendTlsPolicyInfo, ConditionInfo } from "@/generated/types";

const condition = (
  type: string,
  status: string,
  reason: string | null = null
): ConditionInfo => ({
  type,
  status,
  reason,
  message: null,
  lastTransitionTime: null,
});

const policy = (
  name: string,
  over: Partial<BackendTlsPolicyInfo> = {}
): BackendTlsPolicyInfo => ({
  name,
  namespace: "gwtest",
  targetRefs: [{ group: "", kind: "Service", name: "app", sectionName: null }],
  hostname: "app.example.com",
  wellKnownCa: "System",
  caCertRefs: [],
  ancestors: [
    {
      ancestor: {
        group: "gateway.networking.k8s.io",
        kind: "Gateway",
        name: "edge",
        namespace: null,
        sectionName: null,
        port: null,
      },
      controllerName: "example.net/gw",
      conditions: [condition("Accepted", "True", "Accepted")],
    },
  ],
  ancestorsMaybeTruncated: false,
  generation: 1,
  labels: {},
  annotations: {},
  createdAt: "2026-08-19T20:00:00Z",
  ...over,
});

describe("policiesOnService", () => {
  it("finds the policies whose targetRefs name the service", () => {
    const hit = policy("app-tls");
    const miss = policy("other-tls", {
      targetRefs: [
        { group: "", kind: "Service", name: "other", sectionName: null },
      ],
    });
    expect(
      policiesOnService([hit, miss], { name: "app", namespace: "gwtest" })
    ).toEqual([hit]);
  });

  it("never crosses namespaces — GEP-713 direct policies cannot", () => {
    const elsewhere = policy("app-tls", { namespace: "prod" });
    expect(
      policiesOnService([elsewhere], { name: "app", namespace: "gwtest" })
    ).toEqual([]);
  });
});

describe("policyVerdict", () => {
  it("reads accepted from every ancestor agreeing", () => {
    expect(policyVerdict(policy("app-tls"), t)).toEqual({
      word: "accepted",
      tone: "ok",
    });
  });

  it("says conflicted in the loser's own words", () => {
    const loser = policy("app-tls", {
      ancestors: [
        {
          ancestor: {
            group: "gateway.networking.k8s.io",
            kind: "Gateway",
            name: "edge",
            namespace: null,
            sectionName: null,
            port: null,
          },
          controllerName: "example.net/gw",
          conditions: [condition("Accepted", "False", "Conflicted")],
        },
      ],
    });
    expect(policyVerdict(loser, t)).toEqual({
      word: "Conflicted",
      tone: "err",
    });
  });

  it("calls silence unclaimed, not healthy", () => {
    expect(policyVerdict(policy("app-tls", { ancestors: [] }), t)).toEqual({
      word: "no controller answered",
      tone: "warn",
    });
  });

  it("says a full ancestors list may be cut short", () => {
    const full = policy("app-tls", { ancestorsMaybeTruncated: true });
    expect(policyVerdict(full, t).word).toContain("may be truncated");
  });
});
