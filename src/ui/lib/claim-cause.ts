import type {
  EventInfo,
  PersistentVolumeClaimInfo,
  StorageClassInfo,
} from "@/generated/types";
import type { T } from "@/i18n/useT";
import { statusRole, type StatusRole } from "@/lib/status-role";

/** Longest a claim may sit Pending before it counts: provisioning takes seconds. */
export const CLAIM_GRACE_MS = 60_000;

/** The StorageClasses as a reader holds them: still reading, could not read, or read. */
export type ClassesRead = "reading" | "unread" | readonly StorageClassInfo[];

/** Why a claim is Pending, as far as what it names tells. */
export type ClaimCause =
  | { says: "classMissing"; name: string }
  | { says: "noDefaultClass" }
  | { says: "classUnread" }
  | { says: "namesVolume"; volume: string }
  | { says: "staticOnly" }
  | { says: "waitsForPod"; name: string }
  | { says: "noProvisioner"; name: string }
  | { says: "unprovisioned"; name: string; provisioner: string };

/** The roles a cause can take: a fault, a warning, or a wait. */
export type ClaimCauseRole = Extract<StatusRole, "err" | "warn" | "pending">;

const CAUSE_ROLE: Record<ClaimCause["says"], ClaimCauseRole> = {
  classMissing: "err",
  noDefaultClass: "err",
  classUnread: "warn",
  namesVolume: "warn",
  staticOnly: "warn",
  waitsForPod: "pending",
  noProvisioner: "warn",
  unprovisioned: "warn",
};

/** What a class names as its provisioner when volumes are made by hand. */
const NO_PROVISIONER = "kubernetes.io/no-provisioner";

/** Why `claim` is Pending; `null` for a claim that is not, or while its classes are still being read. */
export function claimCause(
  claim: PersistentVolumeClaimInfo,
  classes: ClassesRead
): ClaimCause | null {
  if (claim.status !== "Pending") return null;
  // A claim that names its volume is never provisioned for, whatever its class.
  if (claim.volume) return { says: "namesVolume", volume: claim.volume };
  // Asking for no class is asking for a volume made by hand, never provisioned.
  if (claim.storageClass === "") return { says: "staticOnly" };
  if (classes === "reading") return null;
  if (classes === "unread") return { says: "classUnread" };
  const named = classes.find((each) =>
    claim.storageClass ? each.name === claim.storageClass : each.isDefault
  );
  if (!named)
    return claim.storageClass
      ? { says: "classMissing", name: claim.storageClass }
      : { says: "noDefaultClass" };
  if (named.volumeBindingMode === "WaitForFirstConsumer")
    return { says: "waitsForPod", name: named.name };
  if (named.provisioner === NO_PROVISIONER)
    return { says: "noProvisioner", name: named.name };
  return {
    says: "unprovisioned",
    name: named.name,
    provisioner: named.provisioner,
  };
}

/** A cause's colour, a warning still inside the grace drawn as the wait it may yet be. */
export function causeRole(
  claim: PersistentVolumeClaimInfo,
  cause: ClaimCause,
  now: number
): ClaimCauseRole {
  const role = CAUSE_ROLE[cause.says];
  // Undated claims still report: an unknown age is not evidence of a young one.
  const created = claim.createdAt ? Date.parse(claim.createdAt) : NaN;
  return role === "warn" && now - created < CLAIM_GRACE_MS ? "pending" : role;
}

/** The colour a claim takes: its cause's while Pending, its phase's otherwise. */
export function claimRole(
  claim: PersistentVolumeClaimInfo,
  cause: ClaimCause | null,
  now: number
): StatusRole {
  return cause ? causeRole(claim, cause, now) : statusRole(claim.status ?? "");
}

export function claimCauseText(cause: ClaimCause, t: T): string {
  switch (cause.says) {
    case "classMissing":
      return t("cause", "claimClassMissing", { name: cause.name });
    case "noDefaultClass":
      return t("cause", "claimNoDefaultClass");
    case "classUnread":
      return t("cause", "claimClassUnread");
    case "namesVolume":
      return t("cause", "claimNamesVolume", { volume: cause.volume });
    case "staticOnly":
      return t("cause", "claimStaticOnly");
    case "waitsForPod":
      return t("cause", "claimWaitsForPod", { name: cause.name });
    case "noProvisioner":
      return t("cause", "claimNoProvisioner", { name: cause.name });
    case "unprovisioned":
      return t("cause", "claimUnprovisioned", {
        name: cause.name,
        provisioner: cause.provisioner,
      });
  }
}

/** The newest warning the cluster wrote about the claim, the provisioner's own words for what it could not do. */
export function claimWarning(
  events: readonly EventInfo[] | undefined
): EventInfo | null {
  return (
    events?.find((event) => event.type === "Warning" && event.message) ?? null
  );
}
