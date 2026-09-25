/**
 * What GKE's Ingress CRDs say about one object, reusing `backendConfigSummary`,
 * `frontendConfigSummary`, `healthCheckOf` and the certificate readers, the
 * same readers the CRD columns use.
 */

import { ShieldCheck } from "lucide-react";

import { joinSayings, sayWords } from "@/i18n/say";
import type { T } from "@/i18n/useT";
import type { CustomResourceInfo } from "@/generated/types";
import { iconSvg } from "@/lib/icon-svg";
import type { ReportSection, ReportValue } from "@/lib/report";
import type { StatusRole } from "@/lib/status-role";
import {
  backendConfigSummary,
  certificateDomains,
  certificateStatusOf,
  certificateTone,
  type CertificateTone,
  domainStatuses,
  frontendConfigSummary,
  healthCheckOf,
} from "./model";

function fakeResource(object: {
  namespace: string | null;
  name: string;
  kind: string;
  group: string;
  spec: unknown;
  status: unknown;
}): CustomResourceInfo {
  return {
    name: object.name,
    namespace: object.namespace,
    uid: "",
    apiVersion: `${object.group}/v1`,
    kind: object.kind,
    spec: object.spec,
    status: object.status,
    labels: {},
    annotations: {},
    createdAt: null,
    ownerReferences: [],
    generation: null,
  };
}

function backendConfigSections(
  resource: CustomResourceInfo,
  t: T
): ReportSection[] {
  const health = healthCheckOf(resource);
  const summary = backendConfigSummary(resource);
  const rows: { label: string; values: ReportValue[] }[] = [];
  if (health)
    rows.push({
      label: t("share", "gceHealthCheck"),
      values: [{ text: sayWords(health, t) }],
    });
  rows.push({
    label: t("share", "gceApplies"),
    values: [
      summary.length > 0
        ? { text: joinSayings(summary, t) }
        : { text: t("empty", "nothingConfigured"), quiet: true },
    ],
  });
  return [
    {
      id: "gce-backendconfig",
      title: "BackendConfig",
      icon: iconSvg(ShieldCheck),
      body: { type: "facts", rows },
    },
  ];
}

function frontendConfigSections(
  resource: CustomResourceInfo,
  t: T
): ReportSection[] {
  const summary = frontendConfigSummary(resource);
  return [
    {
      id: "gce-frontendconfig",
      title: "FrontendConfig",
      icon: iconSvg(ShieldCheck),
      body: {
        type: "facts",
        rows: [
          {
            label: t("share", "gceApplies"),
            values: [
              summary.length > 0
                ? { text: joinSayings(summary, t) }
                : { text: t("empty", "nothingConfigured"), quiet: true },
            ],
          },
        ],
      },
    },
  ];
}

/** A status Google has not written yet is unknown, not a warning. */
const TONE_ROLE: Record<CertificateTone, StatusRole> = {
  ok: "ok",
  warn: "warn",
  err: "err",
  unknown: "neutral",
};

function managedCertificateSections(
  resource: CustomResourceInfo,
  t: T
): ReportSection[] {
  const status = certificateStatusOf(resource);
  const domains = certificateDomains(resource);
  const tone = certificateTone(status);
  const perDomain = domainStatuses(resource);
  const rows: { label: string; values: ReportValue[] }[] = [
    {
      label: t("columns", "status"),
      values: [
        status
          ? { text: status, role: TONE_ROLE[tone] }
          : { text: t("share", "notWrittenYet"), quiet: true },
      ],
    },
    {
      label: t("share", "gceDomains"),
      values: [{ text: domains.join(", ") || "-", mono: true }],
    },
  ];
  return [
    {
      id: "gce-managedcertificate",
      title: "ManagedCertificate",
      icon: iconSvg(ShieldCheck),
      count: perDomain.length,
      body: { type: "facts", rows },
    },
    {
      id: "gce-managedcertificate-domains",
      title: t("share", "gceDomains"),
      icon: iconSvg(ShieldCheck),
      count: perDomain.length,
      body: {
        type: "table",
        columns: [t("share", "gceDomains"), t("columns", "status")],
        rows: perDomain.map((entry) => ({
          cells: [
            { text: entry.domain, mono: true },
            {
              text: entry.status,
              role: TONE_ROLE[certificateTone(entry.status)],
            },
          ],
        })),
        more: null,
      },
    },
  ];
}

export function reportOf(
  object: {
    group: string;
    kind: string;
    namespace: string | null;
    name: string;
    spec: unknown;
    status: unknown;
  },
  t: T
): ReportSection[] | null {
  const resource = fakeResource(object);
  if (object.group === "cloud.google.com" && object.kind === "BackendConfig") {
    return backendConfigSections(resource, t);
  }
  if (
    object.group === "networking.gke.io" &&
    object.kind === "FrontendConfig"
  ) {
    return frontendConfigSections(resource, t);
  }
  if (
    object.group === "networking.gke.io" &&
    object.kind === "ManagedCertificate"
  ) {
    return managedCertificateSections(resource, t);
  }
  return null;
}
