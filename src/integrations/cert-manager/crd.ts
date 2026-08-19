/**
 * cert-manager's own custom resources: Certificate, Issuer, ClusterIssuer,
 * CertificateRequest, Order, Challenge.
 *
 * Its CRDs state far more than a printer column reproduces — which Secret a
 * Certificate writes, which issuer signed it, how long the result has left —
 * and none of that is guessable from a CRD the app has never seen.
 */

import type { CrdColumn, CrdStatus } from "../kit";
import { getValueByPath, matchByGroup } from "../kit";
import type { CrdView } from "../registry";
import { daysUntil } from "@/lib/utils";

/**
 * Status configuration for Certificate resources
 */
const certificateStatusConfig: CrdStatus = {
  getStatus: (resource) => {
    const conditions = getValueByPath(resource, "status.conditions") as
      Array<{ type: string; status: string }> | undefined;

    if (!Array.isArray(conditions)) return null;

    const readyCondition = conditions.find((c) => c.type === "Ready");
    if (!readyCondition) return null;

    return readyCondition.status === "True" ? "Ready" : "NotReady";
  },
  getVariant: (status) => {
    switch (status.toLowerCase()) {
      case "ready":
      case "true":
        return "default";
      case "notready":
      case "false":
        return "destructive";
      default:
        return "secondary";
    }
  },
};

/**
 * Columns for Certificate list
 */
const certificateColumns: CrdColumn[] = [
  {
    id: "ready",
    header: "Ready",
    accessor: (resource) => {
      const conditions = getValueByPath(resource, "status.conditions") as
        Array<{ type: string; status: string }> | undefined;

      if (!Array.isArray(conditions)) return "Unknown";

      const readyCondition = conditions.find((c) => c.type === "Ready");
      return readyCondition?.status === "True" ? "True" : "False";
    },
    cell: (value) => String(value ?? "-"),
  },
  {
    id: "secret",
    header: "Secret",
    accessor: (resource) => getValueByPath(resource, "spec.secretName"),
    cell: (value) => String(value ?? "-"),
  },
  {
    id: "issuer",
    header: "Issuer",
    accessor: (resource) => {
      const issuerRef = getValueByPath(resource, "spec.issuerRef") as
        { name: string; kind?: string } | undefined;

      if (!issuerRef) return null;
      return `${issuerRef.kind || "Issuer"}/${issuerRef.name}`;
    },
    cell: (value) => String(value ?? "-"),
  },
  {
    id: "dnsNames",
    header: "DNS Names",
    accessor: (resource) => {
      const dnsNames = getValueByPath(resource, "spec.dnsNames") as
        string[] | undefined;
      return dnsNames?.length ?? 0;
    },
    cell: (value) => (typeof value === "number" ? `${value} names` : "-"),
  },
  {
    id: "expiry",
    header: "Expires",
    accessor: (resource) => getValueByPath(resource, "status.notAfter"),
    cell: (value) => {
      if (!value) return "-";
      const days = daysUntil(value);
      if (days === null) return "-";
      if (days < 0) return "Expired";
      if (days === 0) return "Today";
      if (days === 1) return "Tomorrow";
      return `${days} days`;
    },
  },
];

/**
 * Columns for Issuer/ClusterIssuer list
 */
const issuerColumns: CrdColumn[] = [
  {
    id: "ready",
    header: "Ready",
    accessor: (resource) => {
      const conditions = getValueByPath(resource, "status.conditions") as
        Array<{ type: string; status: string }> | undefined;

      if (!Array.isArray(conditions)) return "Unknown";

      const readyCondition = conditions.find((c) => c.type === "Ready");
      return readyCondition?.status === "True" ? "True" : "False";
    },
    cell: (value) => String(value ?? "-"),
  },
  {
    id: "type",
    header: "Type",
    accessor: (resource) => {
      const spec = getValueByPath(resource, "spec") as
        Record<string, unknown> | undefined;
      if (!spec) return "Unknown";

      // Detect issuer type based on spec fields
      if (spec.acme) return "ACME";
      if (spec.ca) return "CA";
      if (spec.selfSigned) return "SelfSigned";
      if (spec.vault) return "Vault";
      if (spec.venafi) return "Venafi";
      return "Unknown";
    },
    cell: (value) => String(value ?? "-"),
  },
  {
    id: "server",
    header: "Server/Details",
    accessor: (resource) => {
      const spec = getValueByPath(resource, "spec") as
        Record<string, unknown> | undefined;
      if (!spec) return null;

      if (spec.acme) {
        const acme = spec.acme as { server?: string };
        if (acme.server?.includes("letsencrypt.org")) {
          return acme.server.includes("staging")
            ? "Let's Encrypt (Staging)"
            : "Let's Encrypt";
        }
        return acme.server ?? null;
      }
      if (spec.ca) {
        const ca = spec.ca as { secretName?: string };
        return `CA: ${ca.secretName ?? "unknown"}`;
      }
      if (spec.selfSigned) return "Self-Signed";
      if (spec.vault) {
        const vault = spec.vault as { server?: string };
        return vault.server ?? "Vault";
      }
      return null;
    },
    cell: (value) => String(value ?? "-"),
  },
];

/**
 * Columns for CertificateRequest list
 */
const certificateRequestColumns: CrdColumn[] = [
  {
    id: "ready",
    header: "Ready",
    accessor: (resource) => {
      const conditions = getValueByPath(resource, "status.conditions") as
        Array<{ type: string; status: string }> | undefined;

      if (!Array.isArray(conditions)) return "Unknown";

      const readyCondition = conditions.find((c) => c.type === "Ready");
      const approved = conditions.find((c) => c.type === "Approved");
      const denied = conditions.find((c) => c.type === "Denied");

      if (denied?.status === "True") return "Denied";
      if (readyCondition?.status === "True") return "Ready";
      if (approved?.status === "True") return "Approved";
      return "Pending";
    },
    cell: (value) => String(value ?? "-"),
  },
  {
    id: "issuer",
    header: "Issuer",
    accessor: (resource) => {
      const issuerRef = getValueByPath(resource, "spec.issuerRef") as
        { name: string; kind?: string } | undefined;

      if (!issuerRef) return null;
      return `${issuerRef.kind || "Issuer"}/${issuerRef.name}`;
    },
    cell: (value) => String(value ?? "-"),
  },
  {
    id: "requestor",
    header: "Requestor",
    accessor: (resource) => getValueByPath(resource, "spec.username"),
    cell: (value) => String(value ?? "-"),
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
  status: certificateStatusConfig,
};
