import { Unlink } from "lucide-react";

import type { PersistentVolumeClaimInfo } from "@/generated/types";
import { ProblemSummary } from "@/components/object/detail-blocks";
import { ResourceRef } from "@/components/object/ResourceRef";
import { None } from "@/components/ui/none";
import { PhaseBadge, StatusBadge } from "@/components/ui/status-badge";
import { useNow } from "@/hooks/useNow";
import { useObjectEvents } from "@/hooks/useObjectEvents";
import { useClaimCause } from "@/hooks/useStorageClasses";
import { parts } from "@/i18n/parts";
import { useT } from "@/i18n/useT";
import {
  causeRole,
  claimCause,
  claimCauseText,
  claimRole,
  claimWarning,
  type ClaimCause,
  type ClaimCauseRole,
  type ClaimReads,
} from "@/lib/claim-cause";
import { ResourceType } from "@/lib/resource-registry";
import { ROLE_TEXT } from "@/lib/status-role";
import { cn } from "@/lib/utils";
import { CauseEvidence } from "./CauseLine";
import { StorageClassRef } from "./storage-refs";

/** The cause a caller holds, or the one read here where it holds none: the peek has no hooks of its own to read it with. */
function useCauseOf(
  claim: PersistentVolumeClaimInfo,
  given: ClaimCause | null | undefined
): ClaimCause | null {
  const read = useClaimCause(given === undefined ? claim : undefined);
  return given === undefined ? read : given;
}

interface ClaimProps {
  claim: PersistentVolumeClaimInfo;
  cause?: ClaimCause | null;
  className?: string;
}

/** A claim's phase in the colour of why it is Pending, the cause on hover. */
export function ClaimBadge({ claim, cause: given }: ClaimProps) {
  const t = useT();
  const now = useNow();
  const cause = useCauseOf(claim, given);
  if (!claim.status) return <PhaseBadge phase={null} />;
  return (
    <StatusBadge
      status={claim.status}
      roleOverride={claimRole(claim, cause, now)}
      title={cause ? claimCauseText(cause, t) : undefined}
    />
  );
}

/** A list row's badge with the cause after it, the badge kept whole. */
export function ClaimStatusCell({ claim, reads }: CellProps) {
  const t = useT();
  const now = useNow();
  const cause = claimCause(claim, reads);
  const badge = <ClaimBadge claim={claim} cause={cause} />;
  if (!cause) return badge;
  const text = claimCauseText(cause, t);
  return (
    <span className="inline-flex min-w-0 max-w-full items-baseline gap-1.5">
      <span className="flex-none">{badge}</span>
      <span
        className={cn(
          "min-w-0 truncate text-xs",
          ROLE_TEXT[causeRole(claim, cause, now)]
        )}
        title={text}
        data-testid="claim-cause"
      >
        {text}.
      </span>
    </span>
  );
}

interface CellProps {
  claim: PersistentVolumeClaimInfo;
  reads: ClaimReads;
}

/** A name a list row's claim gives that the cluster does not have, marked where a link to nothing would stand. */
function MissingCell({ name, title }: { name: string; title: string }) {
  return (
    <span
      className="inline-flex min-w-0 max-w-full items-center gap-1 text-err"
      title={title}
      data-testid="claim-missing"
    >
      <Unlink className="h-3 w-3 flex-none" aria-hidden="true" />
      <span className="truncate font-mono">{name}</span>
    </span>
  );
}

/** The same on a page or a peek, said in words. */
function MissingLine({ name }: { name: string }) {
  const t = useT();
  return (
    <span
      className="inline-flex items-start gap-1 text-err"
      data-testid="claim-missing"
    >
      <Unlink className="mt-0.5 h-3 w-3 flex-none" aria-hidden="true" />
      <span className="min-w-0">
        {parts(t("readings", "envObjectNotThere"), {
          object: <span className="font-mono">{name}</span>,
        })}
      </span>
    </span>
  );
}

/** The class a list row's claim names, a missing one marked rather than linked. */
export function ClaimClassCell({ claim, reads }: CellProps) {
  const t = useT();
  const cause = claimCause(claim, reads);
  if (cause?.says === "classMissing")
    return <MissingCell name={cause.name} title={claimCauseText(cause, t)} />;
  return (
    <StorageClassRef
      name={claim.storageClass}
      fallback={claim.storageClass === "" ? t("empty", "noneLower") : "default"}
    />
  );
}

/** The volume a list row's claim names, a missing one marked rather than linked. */
export function ClaimVolumeCell({ claim, reads }: CellProps) {
  const t = useT();
  if (!claim.volume) return <None />;
  const cause = claimCause(claim, reads);
  if (cause?.says === "volumeMissing")
    return <MissingCell name={cause.volume} title={claimCauseText(cause, t)} />;
  return (
    <ResourceRef
      kind={ResourceType.PersistentVolume}
      name={claim.volume}
      showKind={false}
    />
  );
}

/** The volume a claim is bound to; with none, a wait by design said as one rather than as a fault. */
export function ClaimVolume({ claim, cause: given }: ClaimProps) {
  const t = useT();
  const now = useNow();
  const cause = useCauseOf(claim, given);
  if (cause?.says === "volumeMissing")
    return <MissingLine name={cause.volume} />;
  if (claim.volume)
    return (
      <ResourceRef
        kind={ResourceType.PersistentVolume}
        name={claim.volume}
        showKind={false}
      />
    );
  const waits = cause !== null && causeRole(claim, cause, now) === "pending";
  return (
    <span className={waits ? ROLE_TEXT.pending : ROLE_TEXT.warn}>
      {t("empty", waits ? "notBoundYet" : "notBoundNothingSatisfied")}
    </span>
  );
}

/** The class a claim names; one the cluster does not have is said where a link to nothing would stand. */
export function ClaimClass({ claim, cause: given }: ClaimProps) {
  const t = useT();
  const cause = useCauseOf(claim, given);
  if (cause?.says === "classMissing") return <MissingLine name={cause.name} />;
  if (claim.storageClass)
    return (
      <ResourceRef
        kind={ResourceType.StorageClass}
        name={claim.storageClass}
        showKind={false}
      />
    );
  return (
    <span className={cn(cause?.says === "noDefaultClass" && ROLE_TEXT.err)}>
      {t(
        "empty",
        claim.storageClass === "" ? "noClassOnPurpose" : "clusterDefault"
      )}
    </span>
  );
}

const SUMMARY_TONE: Record<ClaimCauseRole, "err" | "warn" | "info"> = {
  err: "err",
  warn: "warn",
  pending: "info",
};

/** Why a claim is Pending, above its page and its peek, with the cluster's newest warning about it as the evidence. */
export function ClaimSummary({ claim, cause: given, className }: ClaimProps) {
  const t = useT();
  const now = useNow();
  const cause = useCauseOf(claim, given);
  const events = useObjectEvents(
    ResourceType.PersistentVolumeClaim,
    claim.name,
    claim.namespace,
    { enabled: cause !== null, refresh: "overview", uid: claim.uid }
  );
  if (!cause) return null;
  const role = causeRole(claim, cause, now);
  const warning = claimWarning(events.data);
  return (
    <ProblemSummary
      headline={`${claimCauseText(cause, t)}.`}
      detail={
        (role !== "pending" || warning) && (
          <>
            {role !== "pending" && t("cause", "claimBlocksPods")}
            {warning && (
              <CauseEvidence
                inline
                words={{
                  quote: {
                    label: t("cause", "claimWarned", {
                      reason: warning.reason ?? warning.type,
                    }),
                    text: warning.message ?? "",
                  },
                  note: null,
                }}
              />
            )}
          </>
        )
      }
      tone={SUMMARY_TONE[role]}
      className={className}
    />
  );
}
