import { useQuery } from "@tanstack/react-query";
import { Ghost } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { ErrorDetails } from "@/components/ui/error-details";
import { ResourceRef } from "@/components/object/ResourceRef";
import { parts } from "@/i18n/parts";
import { useT } from "@/i18n/useT";
import { commands } from "@/lib/commands";
import { errorToShow } from "@/lib/error-utils";
import { queryKeys } from "@/lib/query-keys";
import { STALE_TIMES } from "@/lib/refresh";
import type { Owner } from "@/hooks/useLastOwners";
import { OwnerRef } from "../-peek/OwnerRef";

/**
 * A replaced pod's read is a 404, and the raw ApiError said only that. The
 * last read still names who owned it, and so who made what runs now.
 */
export function GoneNotice({
  kind,
  namespace,
  owners,
  error,
  className,
}: {
  kind: string;
  namespace: string | null;
  owners: Owner[] | undefined;
  error: Error | string;
  className?: string;
}) {
  const t = useT();
  const owner = owners?.find((o) => o.controller) ?? owners?.[0];
  const ref = owner && <OwnerRef owner={owner} namespace={namespace} />;
  return (
    <Alert className={className}>
      <Ghost aria-hidden="true" />
      <AlertTitle className="text-fg">
        {t("empty", "goneTitle", { kind })}
      </AlertTitle>
      <AlertDescription className="space-y-1.5">
        {owner ? (
          <p>
            {owner.kind === "ReplicaSet" && namespace ? (
              <ReplicaSetSuccession owner={owner} namespace={namespace} />
            ) : (
              parts(
                t(
                  "empty",
                  REPLACES.has(owner.kind) ? "goneReplacedBy" : "goneOwnedBy",
                  { kind: owner.kind }
                ),
                { owner: ref }
              )
            )}
          </p>
        ) : (
          owners && <p>{t("empty", "goneUnowned")}</p>
        )}
        <ErrorDetails text={errorToShow(error)} />
      </AlertDescription>
    </Alert>
  );
}

/**
 * What replaces a pod a ReplicaSet owned. After a rollout that ReplicaSet is
 * scaled to 0 and replaces nothing: the Deployment above it does, through its
 * current one. Until the ReplicaSet is read, only the ownership is said.
 */
function ReplicaSetSuccession({
  owner,
  namespace,
}: {
  owner: Owner;
  namespace: string;
}) {
  const t = useT();
  const replicaSet = useQuery({
    queryKey: queryKeys.detail("ReplicaSet", namespace, owner.name),
    queryFn: () => commands.getReplicaset(owner.name, namespace),
    staleTime: STALE_TIMES.resourceDetail,
    retry: false,
  }).data;
  const deployment = replicaSet?.ownerReferences.find(
    (ref) => ref.controller && ref.kind === "Deployment"
  );
  const wants = (replicaSet?.replicas.desired ?? 0) > 0;
  const siblings = useQuery({
    queryKey: queryKeys.deploymentReplicaSets(namespace, deployment?.name),
    queryFn: () =>
      commands.getDeploymentReplicasets(deployment!.name, namespace),
    enabled: !!deployment && !wants,
    staleTime: STALE_TIMES.resourceList,
    retry: false,
  }).data;
  const current = siblings?.find(
    (rs) =>
      rs.revision !== null &&
      rs.revision === rs.currentRevision &&
      rs.name !== owner.name
  );
  const nodes = {
    owner: <OwnerRef owner={owner} namespace={namespace} />,
    replicaSet: <OwnerRef owner={owner} namespace={namespace} />,
    deployment: deployment && (
      <ResourceRef
        kind="Deployment"
        name={deployment.name}
        namespace={namespace}
        showKind={false}
      />
    ),
    current: current && (
      <ResourceRef
        kind="ReplicaSet"
        name={current.name}
        namespace={namespace}
        showKind={false}
      />
    ),
  };
  const key = !replicaSet
    ? "goneOwnedBy"
    : !deployment
      ? wants
        ? "goneReplacedBy"
        : "goneScaledDown"
      : wants
        ? "goneThroughReplicaSet"
        : current
          ? "goneRolledTo"
          : "goneRolledOn";
  return parts(t("empty", key, { kind: owner.kind }), nodes);
}

/** Controllers that make a new object when one of theirs disappears. */
const REPLACES = new Set([
  "ReplicaSet",
  "StatefulSet",
  "DaemonSet",
  "ReplicationController",
  "Job",
  "Deployment",
]);
