import { Ban, ChevronRight } from "lucide-react";
import { Fragment, type ReactNode } from "react";

import { ResourceRef } from "@/components/object/ResourceRef";
import { parts } from "@/i18n/parts";
import { useT, type T } from "@/i18n/useT";
import { useLiveQuery } from "@/hooks/useLiveQuery";
import { commands } from "@/lib/commands";
import { queryKeys } from "@/lib/query-keys";
import {
  refusalReason,
  securityLevel,
  type RangeBound,
  type RefusalReason,
} from "@/lib/refusal-reason";
import { cn } from "@/lib/utils";
import { useClusterStore } from "@/stores/clusterStore";

const ENFORCE_LABEL = "pod-security.kubernetes.io/enforce";
const ADMISSION = "admissionregistration.k8s.io";

const Mono = ({ children }: { children: ReactNode }) => (
  <span className="font-mono text-fg">{children}</span>
);

interface Row {
  what: string;
  how: ReactNode;
}

interface Told {
  why: ReactNode;
  rows: readonly Row[];
  /** What else the cluster says about who refused, on a line of its own. */
  after?: ReactNode;
  wayOut: string | null;
}

/**
 * Where the namespace's Pod Security level comes from: its own label, the
 * cluster's default where it sets none, or `null` while it is unread.
 */
function useSecuritySource(
  namespace: string,
  enabled: boolean
): "label" | "default" | null {
  const isConnected = useClusterStore((s) => s.isConnected);
  const read = useLiveQuery({
    queryKey: queryKeys.detail("Namespace", null, namespace),
    queryFn: () => commands.getNamespace(namespace),
    enabled: enabled && isConnected,
    refresh: "slow",
  });
  if (!read.data || read.error) return null;
  return ENFORCE_LABEL in read.data.labels ? "label" : "default";
}

const SECURITY_KEY = {
  label: "refusedBySecurityLabel",
  default: "refusedBySecurityDefault",
  unread: "refusedBySecurity",
} as const;

function rangeHow(bound: RangeBound, t: T): string {
  const values = { allowed: bound.allowed, per: bound.per };
  if (bound.asked === null)
    return t(
      "cause",
      bound.bound === "maximum"
        ? "refusedRangeMaximumUnset"
        : "refusedRangeMinimumUnset",
      values
    );
  return t(
    "cause",
    bound.bound === "maximum" ? "refusedRangeMaximum" : "refusedRangeMinimum",
    { ...values, asked: bound.asked }
  );
}

/** The quoted words a policy or webhook gave, after its sentence. */
const said = (text: string) => (
  <>
    {" "}
    <span className="font-mono wrap-break-word text-fg">{text}</span>
  </>
);

function told(
  reason: Exclude<RefusalReason, { by: "unknown" }>,
  namespace: string,
  source: "label" | "default" | null,
  t: T
): Told {
  switch (reason.by) {
    case "podSecurity":
      return {
        why: parts(
          t("cause", SECURITY_KEY[source ?? "unread"], {
            n: reason.checks.length,
          }),
          {
            namespace: (
              <ResourceRef kind="Namespace" name={namespace} showKind={false} />
            ),
            level: <Mono>{securityLevel(reason)}</Mono>,
            label: <Mono>{ENFORCE_LABEL}</Mono>,
          }
        ),
        rows: reason.checks.map((check) => ({
          what: check.check,
          how: check.how && <Mono>{check.how}</Mono>,
        })),
        wayOut: t("cause", "refusedSecurityWayOut"),
      };
    case "quotaExceeded":
      return {
        why: parts(t("cause", "refusedByQuota"), {
          quota: (
            <ResourceRef
              kind="ResourceQuota"
              crd="resourcequotas"
              name={reason.quota}
              namespace={namespace}
              showKind={false}
            />
          ),
        }),
        rows: reason.over.map((over) => ({
          what: over.resource,
          how:
            over.used !== null && over.limited !== null
              ? t("cause", "refusedQuotaRow", {
                  used: over.used,
                  limited: over.limited,
                  requested: over.requested,
                })
              : t("cause", "refusedQuotaAsks", { requested: over.requested }),
        })),
        wayOut: t("cause", "refusedQuotaWayOut"),
      };
    case "quotaUnset":
      return {
        why: parts(t("cause", "refusedByQuotaUnset"), {
          quota: (
            <ResourceRef
              kind="ResourceQuota"
              crd="resourcequotas"
              name={reason.quota}
              namespace={namespace}
              showKind={false}
            />
          ),
        }),
        rows: reason.unset.map((unset) => ({
          what: unset.resource,
          how:
            unset.containers.length > 0
              ? t("cause", "refusedUnsetIn", {
                  containers: unset.containers.join(", "),
                })
              : t("cause", "refusedUnset"),
        })),
        wayOut: t("cause", "refusedQuotaUnsetWayOut"),
      };
    case "limitRange":
      return {
        why: t("cause", "refusedByLimitRange"),
        rows: reason.bounds.map((bound) => ({
          what: bound.resource,
          how: rangeHow(bound, t),
        })),
        wayOut: t("cause", "refusedRangeWayOut"),
      };
    case "serviceAccount":
      return {
        why: parts(t("cause", "refusedByServiceAccount"), {
          name: <Mono>{reason.name}</Mono>,
          namespace: (
            <ResourceRef
              kind="Namespace"
              name={reason.namespace}
              showKind={false}
            />
          ),
        }),
        rows: [],
        wayOut: t("cause", "refusedServiceAccountWayOut"),
      };
    case "policy":
      return {
        why: (
          <>
            {parts(t("cause", "refusedByPolicy"), {
              policy: (
                <ResourceRef
                  kind="ValidatingAdmissionPolicy"
                  crd={`validatingadmissionpolicies.${ADMISSION}`}
                  name={reason.policy}
                  showKind={false}
                />
              ),
              binding: (
                <ResourceRef
                  kind="ValidatingAdmissionPolicyBinding"
                  crd={`validatingadmissionpolicybindings.${ADMISSION}`}
                  name={reason.binding}
                  showKind={false}
                />
              ),
            })}
            {said(reason.said)}
          </>
        ),
        rows: [],
        wayOut: t("cause", "refusedRuleWayOut"),
      };
    case "webhookDenied":
      return {
        why: reason.said ? (
          <>
            {parts(t("cause", "refusedByWebhook"), {
              webhook: <Mono>{reason.webhook}</Mono>,
            })}
            {said(reason.said)}
          </>
        ) : (
          parts(t("cause", "refusedByWebhookSilent"), {
            webhook: <Mono>{reason.webhook}</Mono>,
          })
        ),
        rows: [],
        wayOut: t("cause", "refusedRuleWayOut"),
      };
    case "webhookFailed":
      return {
        why: (
          <>
            {parts(t("cause", "refusedByWebhookDown"), {
              webhook: <Mono>{reason.webhook}</Mono>,
            })}
            {said(reason.said)}
          </>
        ),
        rows: [],
        after:
          reason.service &&
          parts(t("cause", "refusedWebhookService"), {
            service: (
              <ResourceRef
                kind="Service"
                name={reason.service.name}
                namespace={reason.service.namespace}
                showKind={false}
              />
            ),
            namespace: (
              <ResourceRef
                kind="Namespace"
                name={reason.service.namespace}
                showKind={false}
              />
            ),
          }),
        wayOut: t("cause", "refusedWebhookDownWayOut"),
      };
    case "terminating":
      return {
        why: parts(t("cause", "refusedByTerminating"), {
          namespace: (
            <ResourceRef
              kind="Namespace"
              name={reason.namespace}
              showKind={false}
            />
          ),
        }),
        rows: [],
        wayOut: null,
      };
  }
}

/**
 * The API server's refusal of a workload's pods, explained: who refused,
 * what they hold against the template, and the way out, with its own words
 * one click away. An answer of a shape not known here is quoted as it is.
 */
export function RefusalExplained({
  said: answer,
  namespace,
  lead,
  className,
}: {
  said: string;
  namespace: string;
  lead?: ReactNode;
  className?: string;
}) {
  const t = useT();
  const reason = refusalReason(answer);
  const source = useSecuritySource(namespace, reason.by === "podSecurity");
  const mark = (
    <Ban
      className="mr-1 inline h-2.5 w-2.5 align-[-1px] text-err"
      aria-hidden="true"
    />
  );
  if (reason.by === "unknown")
    return (
      <p className={cn("text-xs", className)} data-testid="refused-line">
        {lead && <span className="text-fg-mut">{lead} </span>}
        {mark}
        <span className="text-err">{t("cause", "podsRefused")}.</span>
        {answer && (
          <>
            {" "}
            <span className="text-fg-mut">
              {t("cause", "refusalSaid")}
            </span>{" "}
            <span className="font-mono wrap-break-word text-fg">{answer}</span>
          </>
        )}
      </p>
    );
  const { why, rows, after, wayOut } = told(reason, namespace, source, t);
  return (
    <div
      className={cn("@container text-xs", className)}
      data-testid="refused-line"
    >
      <p>
        {lead && <span className="text-fg-mut">{lead} </span>}
        {mark}
        <span className="text-err">{t("cause", "podsRefused")}.</span>{" "}
        <span className="text-fg">{why}</span>
      </p>
      {rows.length > 0 && (
        <dl
          className="mt-1.5 grid grid-cols-1 gap-x-4 gap-y-0.5 pl-3.5 @3xl:grid-cols-[auto_minmax(0,1fr)] @3xl:gap-y-1"
          data-testid="refusal-rows"
        >
          {rows.map((row) => (
            <Fragment key={row.what}>
              <dt className="font-mono text-err">{row.what}</dt>
              <dd className="mb-1 pl-3 wrap-break-word text-fg-mut @3xl:mb-0 @3xl:pl-0">
                {row.how}
              </dd>
            </Fragment>
          ))}
        </dl>
      )}
      {after && <p className="mt-1.5 pl-3.5 text-fg-mut">{after}</p>}
      {wayOut && <p className="mt-1.5 pl-3.5 text-fg-mut">{wayOut}</p>}
      <details className="group mt-1 pl-3.5">
        <summary className="inline-flex cursor-pointer select-none items-center gap-1 rounded-md py-0.5 text-fg-fnt hover:text-fg-mut">
          {t("cause", "refusalRaw")}
          <ChevronRight
            className="h-3 w-3 transition-transform duration-200 group-open:rotate-90 motion-reduce:transition-none"
            aria-hidden="true"
          />
        </summary>
        <p className="mt-1 font-mono wrap-break-word text-fg-mut">{answer}</p>
      </details>
    </div>
  );
}
