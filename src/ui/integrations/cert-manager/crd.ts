/**
 * cert-manager's own custom resources: Certificate, Issuer, ClusterIssuer,
 * CertificateRequest, Order, Challenge.
 *
 * Its CRDs state far more than a printer column reproduces — which Secret a
 * Certificate writes, which issuer signed it, how long the result has left —
 * and none of that is guessable from a CRD the app has never seen.
 */

import type { CrdColumn } from "../kit";
import { getValueByPath, matchByGroup, orNone, orNotWritten } from "../kit";
import type { CrdView } from "../registry";
import { daysUntil } from "@/lib/utils";
import { acmeServerLabel } from "./model";

/**
 * Status configuration for Certificate resources
 */
/**
 * Columns for Certificate list
 */
const certificateColumns: CrdColumn[] = [
  {
    id: "ready",
    header: "ready",
    accessor: (resource) => {
      const conditions = getValueByPath(resource, "status.conditions") as
        | Array<{ type: string; status: string }>
        | undefined;

      if (!Array.isArray(conditions)) return "Unknown";

      const readyCondition = conditions.find((c) => c.type === "Ready");
      return readyCondition?.status === "True" ? "True" : "False";
    },
    cell: orNone,
  },
  {
    id: "secret",
    header: "secret",
    accessor: (resource) => getValueByPath(resource, "spec.secretName"),
    cell: orNone,
  },
  {
    id: "issuer",
    header: "issuer",
    accessor: (resource) => {
      const issuerRef = getValueByPath(resource, "spec.issuerRef") as
        | { name: string; kind?: string }
        | undefined;

      if (!issuerRef) return null;
      return `${issuerRef.kind || "Issuer"}/${issuerRef.name}`;
    },
    cell: orNone,
  },
  {
    id: "dnsNames",
    header: "dnsNames",
    accessor: (resource) => {
      const dnsNames = getValueByPath(resource, "spec.dnsNames") as
        | string[]
        | undefined;
      return dnsNames?.length ?? 0;
    },
    cell: (value, t) =>
      typeof value === "number"
        ? t("count", "dnsNames", { n: value })
        : orNone(null),
  },
  {
    id: "expiry",
    header: "expires",
    accessor: (resource) => getValueByPath(resource, "status.notAfter"),
    cell: (value, t) => {
      if (!value) return orNotWritten(null, t);
      const days = daysUntil(value);
      if (days === null) return String(value);
      if (days < 0) return t("readings", "expiredWord");
      if (days === 0) return t("action", "today");
      return t("count", "inDays", { n: days });
    },
  },
];

/**
 * Columns for Issuer/ClusterIssuer list
 */
const issuerColumns: CrdColumn[] = [
  {
    id: "ready",
    header: "ready",
    accessor: (resource) => {
      const conditions = getValueByPath(resource, "status.conditions") as
        | Array<{ type: string; status: string }>
        | undefined;

      if (!Array.isArray(conditions)) return "Unknown";

      const readyCondition = conditions.find((c) => c.type === "Ready");
      return readyCondition?.status === "True" ? "True" : "False";
    },
    cell: orNone,
  },
  {
    id: "type",
    header: "type",
    accessor: (resource) => {
      const spec = getValueByPath(resource, "spec") as
        | Record<string, unknown>
        | undefined;
      if (!spec) return "Unknown";

      // Detect issuer type based on spec fields
      if (spec.acme) return "ACME";
      if (spec.ca) return "CA";
      if (spec.selfSigned) return "SelfSigned";
      if (spec.vault) return "Vault";
      if (spec.venafi) return "Venafi";
      return "Unknown";
    },
    cell: orNone,
  },
  {
    id: "server",
    header: "serverDetails",
    accessor: (resource, t) => {
      const spec = getValueByPath(resource, "spec") as
        | Record<string, unknown>
        | undefined;
      if (!spec) return null;

      if (spec.acme) {
        const acme = spec.acme as { server?: string };
        return acmeServerLabel(acme.server ?? null);
      }
      if (spec.ca) {
        const ca = spec.ca as { secretName?: string };
        return `CA: ${ca.secretName ?? t("empty", "unknownLower")}`;
      }
      if (spec.selfSigned) return "Self-Signed";
      if (spec.vault) {
        const vault = spec.vault as { server?: string };
        return vault.server ?? "Vault";
      }
      return null;
    },
    cell: orNone,
  },
];

/**
 * Columns for CertificateRequest list
 */
const certificateRequestColumns: CrdColumn[] = [
  {
    id: "ready",
    header: "ready",
    accessor: (resource) => {
      const conditions = getValueByPath(resource, "status.conditions") as
        | Array<{ type: string; status: string }>
        | undefined;

      if (!Array.isArray(conditions)) return "Unknown";

      const readyCondition = conditions.find((c) => c.type === "Ready");
      const approved = conditions.find((c) => c.type === "Approved");
      const denied = conditions.find((c) => c.type === "Denied");

      if (denied?.status === "True") return "Denied";
      if (readyCondition?.status === "True") return "Ready";
      if (approved?.status === "True") return "Approved";
      return "Pending";
    },
    cell: orNone,
  },
  {
    id: "issuer",
    header: "issuer",
    accessor: (resource) => {
      const issuerRef = getValueByPath(resource, "spec.issuerRef") as
        | { name: string; kind?: string }
        | undefined;

      if (!issuerRef) return null;
      return `${issuerRef.kind || "Issuer"}/${issuerRef.name}`;
    },
    cell: orNone,
  },
  {
    id: "requestor",
    header: "requestor",
    accessor: (resource) => getValueByPath(resource, "spec.username"),
    cell: orNone,
  },
];

/**
 * Every kind in `cert-manager.io`, and a column set for the three whose
 * shapes differ. Anything newer falls back to the Certificate columns
 * rather than to nothing.
 */
export const crd: CrdView = {
  matches: matchByGroup("cert-manager.io"),
  columnsFor: (kind) => {
    switch (kind.toLowerCase()) {
      case "certificate":
        return certificateColumns;
      case "issuer":
      case "clusterissuer":
        return issuerColumns;
      case "certificaterequest":
        return certificateRequestColumns;
      default:
        return certificateColumns;
    }
  },
};
