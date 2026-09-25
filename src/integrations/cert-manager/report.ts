/**
 * What cert-manager's own kinds say about one object, read from its spec and
 * status alone. The full walk to a Certificate's Order and Challenge lives
 * in `./model.ts` and needs the cluster's other objects, which `object.report`
 * does not have.
 */

import { ShieldCheck } from "lucide-react";

import type { T } from "@/i18n/useT";
import { expiryText, managedExpiryOf } from "@/lib/certificates";
import { iconSvg } from "@/lib/icon-svg";
import { refOf } from "@/lib/report-parts";
import type { ReportSection, ReportValue } from "@/lib/report";
import { conditionFromStatus } from "../kit";
import { conditionRole } from "@/lib/condition-health";

const GROUP = "cert-manager.io";
const ACME_GROUP = "acme.cert-manager.io";

function text(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function at(object: unknown, ...path: string[]): unknown {
  return path.reduce<unknown>(
    (current, key) =>
      current && typeof current === "object"
        ? (current as Record<string, unknown>)[key]
        : undefined,
    object
  );
}

function readyValue(status: unknown, t: T): ReportValue {
  const ready = conditionFromStatus(status, "Ready");
  if (!ready) return { text: t("share", "notWrittenYet"), quiet: true };
  return { text: ready.status, role: conditionRole(ready) };
}

function certificateSection(
  spec: unknown,
  status: unknown,
  namespace: string | null,
  t: T
): ReportSection {
  const issuerName = text(at(spec, "issuerRef", "name"));
  const issuerKind = text(at(spec, "issuerRef", "kind")) ?? "Issuer";
  const secretName = text(at(spec, "secretName"));
  const dnsNames = strings(at(spec, "dnsNames"));
  const notAfter = text(at(status, "notAfter"));
  const notBefore = text(at(status, "notBefore"));
  const renewalTime = text(at(status, "renewalTime"));

  const rows: { label: string; values: ReportValue[] }[] = [
    { label: t("columns", "status"), values: [readyValue(status, t)] },
  ];
  if (notAfter) {
    const expiry = managedExpiryOf(
      { notAfter, notBefore: notBefore ?? "" },
      renewalTime
    );
    rows.push({
      label: t("share", "cmNotAfter"),
      values: [
        {
          text: expiryText(expiry, t),
          role:
            expiry.tone === "err"
              ? "err"
              : expiry.tone === "warn"
                ? "warn"
                : "ok",
        },
      ],
    });
  }
  if (issuerName) {
    rows.push({
      label: t("share", "cmIssuer"),
      values: [
        {
          text: issuerName,
          ref: refOf({
            kind: issuerKind,
            name: issuerName,
            namespace: issuerKind === "ClusterIssuer" ? null : namespace,
          }),
        },
      ],
    });
  }
  if (dnsNames.length > 0) {
    rows.push({
      label: t("share", "cmDnsNames"),
      values: [{ text: dnsNames.join(", "), mono: true }],
    });
  }
  if (secretName) {
    rows.push({
      label: t("share", "cmSecret"),
      values: [
        {
          text: secretName,
          ref: refOf({ kind: "Secret", name: secretName, namespace }),
        },
      ],
    });
  }

  return {
    id: "cert-manager-certificate",
    title: "Certificate",
    icon: iconSvg(ShieldCheck),
    body: { type: "facts", rows },
  };
}

function issuerType(
  spec: unknown
): { type: string; detail: string | null } | null {
  if (at(spec, "acme")) {
    const server = text(at(spec, "acme", "server"));
    return {
      type: "ACME",
      detail: server?.includes("letsencrypt.org")
        ? server.includes("staging")
          ? "Let's Encrypt staging"
          : "Let's Encrypt"
        : server,
    };
  }
  if (at(spec, "ca"))
    return { type: "CA", detail: text(at(spec, "ca", "secretName")) };
  if (at(spec, "selfSigned")) return { type: "SelfSigned", detail: null };
  if (at(spec, "vault"))
    return { type: "Vault", detail: text(at(spec, "vault", "server")) };
  if (at(spec, "venafi")) return { type: "Venafi", detail: null };
  return null;
}

function issuerSection(
  spec: unknown,
  status: unknown,
  kind: string,
  t: T
): ReportSection {
  const shape = issuerType(spec);
  const rows: { label: string; values: ReportValue[] }[] = [
    { label: t("columns", "status"), values: [readyValue(status, t)] },
    {
      label: t("share", "cmIssuerType"),
      values: [
        shape
          ? { text: [shape.type, shape.detail].filter(Boolean).join(" · ") }
          : { text: t("share", "cmIssuerTypeUnknown"), quiet: true },
      ],
    },
  ];
  return {
    id: "cert-manager-issuer",
    title: kind,
    icon: iconSvg(ShieldCheck),
    body: { type: "facts", rows },
  };
}

function stepSection(
  id: string,
  kind: string,
  status: unknown,
  extra: { label: string; values: ReportValue[] }[],
  t: T
): ReportSection {
  const state = text(at(status, "state"));
  const reason = text(at(status, "reason"));
  const rows: { label: string; values: ReportValue[] }[] = [
    ...extra,
    {
      label: t("columns", "status"),
      values: [
        state
          ? {
              text: state,
              role:
                state === "invalid" || state === "errored"
                  ? "err"
                  : state === "valid" || state === "ready"
                    ? "ok"
                    : "pending",
            }
          : { text: t("share", "notWrittenYet"), quiet: true },
      ],
    },
  ];
  if (reason)
    rows.push({ label: t("columns", "reason"), values: [{ text: reason }] });
  return {
    id,
    title: kind,
    icon: iconSvg(ShieldCheck),
    body: { type: "facts", rows },
  };
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
  if (object.group === GROUP) {
    switch (object.kind) {
      case "Certificate":
        return [
          certificateSection(object.spec, object.status, object.namespace, t),
        ];
      case "Issuer":
      case "ClusterIssuer":
        return [issuerSection(object.spec, object.status, object.kind, t)];
      case "CertificateRequest":
        return [
          stepSection(
            "cert-manager-request",
            object.kind,
            object.status,
            [],
            t
          ),
        ];
      default:
        return null;
    }
  }
  if (object.group === ACME_GROUP) {
    switch (object.kind) {
      case "Order":
        return [
          stepSection("cert-manager-order", object.kind, object.status, [], t),
        ];
      case "Challenge": {
        const type = text(at(object.spec, "type"));
        const dnsName = text(at(object.spec, "dnsName"));
        const extra: { label: string; values: ReportValue[] }[] = [];
        if (type)
          extra.push({
            label: t("share", "cmChallengeType"),
            values: [{ text: type, mono: true }],
          });
        if (dnsName)
          extra.push({
            label: t("columns", "hosts"),
            values: [{ text: dnsName, mono: true }],
          });
        return [
          stepSection(
            "cert-manager-challenge",
            object.kind,
            object.status,
            extra,
            t
          ),
        ];
      }
      default:
        return null;
    }
  }
  return null;
}
