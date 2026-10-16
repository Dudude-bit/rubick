/**
 * A LoadBalancer Service's address, and whether it is coming.
 *
 * Kubernetes never assigns this address itself: an implementation running
 * in the cluster does, a cloud's controller or an in-cluster one. "pending"
 * alone reads as transient, and on a cluster with no implementation it is
 * permanent. The one thing the cluster can say about it is whether any
 * LoadBalancer Service here has ever been given an address.
 */

import type { T } from "@/i18n/useT";
import type { ServiceInfo } from "@/generated/types";
import { errorToShow } from "@/lib/error-utils";
import type { StatusRole } from "@/lib/status-role";

/** What the cluster's other Services say about who hands out addresses. */
export type BalancerEvidence =
  | { known: true; assigned: number }
  | { known: false; why: string | null };

export function balancerEvidence(
  services: readonly ServiceInfo[] | undefined,
  error: unknown
): BalancerEvidence {
  if (error) return { known: false, why: errorToShow(error) };
  if (!services) return { known: false, why: null };
  return {
    known: true,
    assigned: services.filter(
      (service) =>
        service.type === "LoadBalancer" && service.loadBalancerIps.length > 0
    ).length,
  };
}

export type BalancerAddress =
  | { state: "notBalancer" }
  | { state: "assigned"; addresses: string[] }
  /** Other LoadBalancer Services have addresses: an implementation exists. */
  | { state: "waiting" }
  /** None has one: nothing here has ever assigned an address. */
  | { state: "neverAssigned" }
  | { state: "cannotTell"; why: string | null };

export function balancerAddressOf(
  service: Pick<ServiceInfo, "type" | "loadBalancerIps">,
  evidence: BalancerEvidence
): BalancerAddress {
  if (service.type !== "LoadBalancer") return { state: "notBalancer" };
  if (service.loadBalancerIps.length > 0) {
    return { state: "assigned", addresses: service.loadBalancerIps };
  }
  if (!evidence.known) return { state: "cannotTell", why: evidence.why };
  return evidence.assigned > 0
    ? { state: "waiting" }
    : { state: "neverAssigned" };
}

/** Whether the address is missing, which is when anything needs saying. */
export const balancerMissing = (address: BalancerAddress): boolean =>
  address.state === "waiting" ||
  address.state === "neverAssigned" ||
  address.state === "cannotTell";

/** The missing address as a badge and the sentence behind it. */
export function balancerWords(
  address: Extract<
    BalancerAddress,
    { state: "waiting" | "neverAssigned" | "cannotTell" }
  >,
  nodePorts: readonly number[],
  t: T
): { label: string; role: StatusRole; reason: string } {
  const fallback =
    nodePorts.length > 0
      ? ` ${t("readings", "lbNodePortFallback", { ports: nodePorts.join(", ") })}`
      : "";
  switch (address.state) {
    case "waiting":
      return {
        label: t("readings", "lbWaiting"),
        role: "pending",
        reason: t("readings", "lbWaitingWhy") + fallback,
      };
    case "neverAssigned":
      return {
        label: t("readings", "lbNeverAssigned"),
        role: "err",
        reason: t("readings", "lbNeverAssignedWhy") + fallback,
      };
    case "cannotTell":
      return {
        label: t("readings", "lbWaiting"),
        role: "neutral",
        reason:
          t("readings", "lbCannotTellWhy", {
            why: address.why ?? t("readings", "lbNotReadYet"),
          }) + fallback,
      };
  }
}
