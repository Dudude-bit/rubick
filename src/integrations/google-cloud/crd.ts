/**
 * GKE's Ingress objects, drawn as what they configure.
 *
 * All three land on the same list page today as a name and an age, which for
 * a `ManagedCertificate` means the reader has to open every one to find the
 * domain that is not provisioning. The columns are the fields somebody would
 * have opened it for.
 *
 * Two API groups, because GKE splits them: `BackendConfig` is
 * `cloud.google.com`, and `FrontendConfig` and `ManagedCertificate` are both
 * `networking.gke.io`. The group is matched rather than sniffed — reaching
 * one of these list pages requires the CRD to exist, so the group *is* the
 * detection and there is nothing to ask the cluster.
 */

import type { CrdColumn } from "../kit";
import { NO_STATUS, matchMultiple } from "../kit";
import type { CrdView } from "../registry";
import {
  backendConfigSummary,
  certificateDomains,
  certificateStatusOf,
  certificateTone,
  domainStatuses,
  frontendConfigSummary,
  healthCheckOf,
} from "./model";

const dash = (value: unknown) =>
  value === null || value === undefined || value === "" ? "—" : String(value);

const backendConfigColumns: CrdColumn[] = [
  {
    id: "healthCheck",
    header: "Health check",
    accessor: (resource) => healthCheckOf(resource),
    cell: dash,
  },
  {
    id: "behaviour",
    header: "Applies",
    accessor: (resource) => backendConfigSummary(resource),
    cell: dash,
  },
];

const frontendConfigColumns: CrdColumn[] = [
  {
    id: "behaviour",
    header: "Applies",
    accessor: (resource) => frontendConfigSummary(resource),
    cell: dash,
  },
];

const managedCertificateColumns: CrdColumn[] = [
  {
    id: "certificateStatus",
    header: "Status",
    accessor: (resource) => certificateStatusOf(resource),
    // Not a badge, and deliberately: an empty status is what the controller
    // writes before it has looked at the certificate *and* what a cluster
    // with no controller running has, and a pill saying "Unknown" over the
    // second one would dress a missing controller up as a certificate state.
    cell: (value) => (typeof value === "string" && value !== "" ? value : "—"),
  },
  {
    id: "domains",
    header: "Domains",
    accessor: (resource) => certificateDomains(resource).join(", "),
    cell: dash,
  },
  {
    id: "notProvisioned",
    header: "Not provisioned",
    // The column the list page exists for. A certificate with four domains
    // and one FailedNotVisible reads as "Provisioning" at the top level for
    // as long as anybody leaves it, and this is the only place that names
    // the domain whose DNS never got pointed here.
    accessor: (resource) =>
      domainStatuses(resource)
        .filter((entry) => certificateTone(entry.status) !== "ok")
        .map((entry) => `${entry.domain} ${entry.status}`)
        .join(", "),
    cell: dash,
  },
];

/**
 * Both of GKE's Ingress groups, and no status for two of the three kinds.
 *
 * {@link NO_STATUS} on the view is the honest answer rather than a stub:
 * `BackendConfig` and `FrontendConfig` genuinely do not report health, and a
 * status derived from their spec would be this app inventing a verdict for
 * an object that has never had one. Only `ManagedCertificate` has one to
 * report, and it is in its own column above.
 */
export const crd: CrdView = {
  matches: matchMultiple([
    ["cloud.google.com", "BackendConfig"],
    ["networking.gke.io", "FrontendConfig"],
    ["networking.gke.io", "ManagedCertificate"],
  ]),
  columnsFor: (kind) => {
    switch (kind.toLowerCase()) {
      case "frontendconfig":
        return frontendConfigColumns;
      case "managedcertificate":
        return managedCertificateColumns;
      default:
        return backendConfigColumns;
    }
  },
  status: NO_STATUS,
};
