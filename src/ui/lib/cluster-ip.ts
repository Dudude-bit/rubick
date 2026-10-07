import type { T } from "@/i18n/useT";

/**
 * A Service's cluster IP as one fact for every reader: an address, the API's
 * own `None` that makes a Service headless, or none at all, which is what an
 * ExternalName Service has.
 */
export type ClusterIp =
  | { state: "address"; address: string }
  | { state: "headless" }
  | { state: "none" };

export function clusterIpOf(clusterIp: string | null): ClusterIp {
  if (clusterIp === "None") return { state: "headless" };
  if (!clusterIp) return { state: "none" };
  return { state: "address", address: clusterIp };
}

/** The same fact as text, for the shared file. */
export function clusterIpText(clusterIp: string | null, t: T): string {
  const ip = clusterIpOf(clusterIp);
  if (ip.state === "address") return ip.address;
  return ip.state === "headless"
    ? t("empty", "clusterIpHeadless")
    : t("empty", "noneLower");
}
