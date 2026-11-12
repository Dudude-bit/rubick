/**
 * Which of the five answers `/integrations/<slug>` gets, decided from what
 * detection and the connection reads came back with — and nothing else.
 *
 * Split from the hook because the rule it encodes was already stated once in
 * `useIntegrationPages` — a configured vendor is present because its address
 * answered, never because a CRD scan found it, it installs none — and then
 * not applied to the page gate. The gate read detection alone, the detector
 * has no entry for a configured-only vendor, and the page said "Prometheus
 * is not installed in this cluster" over a connected Prometheus, blaming
 * custom resource definitions the vendor never had.
 */

export type PageDecision =
  | "unknown"
  | "detecting"
  | "absent"
  /** The scan was refused, so neither "here" nor "not here" was established. */
  | "cannotTell"
  | "notConfigured"
  | "ready";

export function pageDecision(
  vendor: { id: string; configured: boolean } | undefined,
  detected: Array<{ id: string; installed: boolean | null }> | undefined,
  connection: { state: string } | undefined
): PageDecision {
  if (!vendor) return "unknown";

  // An install the scan can see answers first, whatever the connection
  // says: a cluster running the thing is never sent to configure a URL.
  if (detected?.some((entry) => entry.id === vendor.id && entry.installed)) {
    return "ready";
  }

  if (vendor.configured) {
    if (!connection || connection.state === "reading") return "detecting";
    // An address that was given opens the page whether or not the scan
    // found the vendor's kinds: unreachable is said on the page, and a
    // cluster without the kinds still has the connection to show.
    if (connection.state !== "notConfigured") return "ready";
    const scanned = detected?.some((entry) => entry.id === vendor.id);
    if (!scanned) return "notConfigured";
  }

  if (!detected) return "detecting";
  // An entry with no answer in it is the cluster declining to look, and
  // "absent" is a claim about the cluster that nothing established.
  const entry = detected.find((candidate) => candidate.id === vendor.id);
  if (entry && entry.installed === null) return "cannotTell";
  // Absent from the scan and with no address: for a vendor that takes one,
  // the way in is the address, so that is the answer to give.
  return vendor.configured ? "notConfigured" : "absent";
}
