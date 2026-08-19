/**
 * The AWS Load Balancer Controller's page: one row per load balancer, not per
 * Ingress.
 *
 * That pivot is the whole point and it is this controller's alone. Everywhere
 * else in Kubernetes an Ingress owns its load balancer, so an Ingress page is
 * the whole story. Here `group.name` merges Ingresses **across namespaces**
 * onto one ALB — their rules concatenated, ordered by `group.order`, sharing
 * a certificate, a scheme, a WAF and a subnet set that only one of them
 * declared. An Ingress cannot show any of that: its neighbour is in another
 * namespace and is never drawn beside it.
 *
 * Nothing here reports health it was not told. `IngressClassParams` has no
 * status, and a `TargetGroupBinding` gets a condition only when the
 * controller failed — so every state on this page is a disagreement between
 * objects, a name that resolves to nothing, or the controller's own sentence.
 * Whether the targets in a group are passing their health checks lives in the
 * ELB API, one credential up.
 */

import { useMemo, useState } from "react";

import { Section, SectionHeader } from "@/components/ui/section";
import { ObjectLink, ResourceRef } from "@/components/resources/ResourceRef";
import { ResourceType } from "@/lib/resource-registry";
import {
  Cell,
  Chain,
  Column,
  FilterBox,
  Finding,
  TroubleRow,
  type Tone,
} from "../page-kit";
import { useAlbSources } from "./data";
import { albGroups, type AlbFinding, type AlbGroup } from "./groups";
import { useT } from "@/i18n/useT";
import {
  INGRESS_CLASS_PARAMS_CRD,
  TARGET_GROUP_BINDING_CRD,
  bindingFailure,
  bindingSummary,
  boundService,
} from "./model";
import type { en } from "@/i18n/catalogue";

/** Past this many groups with a finding, nothing opens itself. */
const AUTO_OPEN = 6;

export default function AwsLoadBalancerPage() {
  const t = useT();
  const sources = useAlbSources();
  const [filter, setFilter] = useState("");

  const groups = useMemo(
    () =>
      sources.data
        ? albGroups({
            ingresses: sources.data.ingresses,
            params: sources.data.params,
            classParams: sources.data.classParams,
            ownClasses: sources.data.ownClasses,
          })
        : [],
    [sources.data]
  );

  const shown = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    if (needle === "") return groups;
    return groups.filter(
      (group) =>
        (group.name ?? "").toLowerCase().includes(needle) ||
        group.members.some(
          (member) =>
            member.ingress.name.toLowerCase().includes(needle) ||
            member.ingress.namespace.toLowerCase().includes(needle) ||
            member.hosts.some((host) => host.toLowerCase().includes(needle))
        )
    );
  }, [groups, filter]);

  const troubled = groups.filter((group) => group.worst !== null).length;

  if (sources.error) {
    return (
      <Section className="max-w-[64ch] py-8">
        <h2 className="text-[13px] font-semibold tracking-tight text-err">
          {t("empty", "couldNotReadIngresses")}
        </h2>
        <p className="text-[11px] text-fg-fnt">{sources.error.message}</p>
      </Section>
    );
  }

  return (
    <div className="flex flex-col gap-[22px]">
      <SectionHeader
        title="AWS Load Balancer Controller"
        count={
          sources.isPending
            ? undefined
            : t("count", "loadBalancers", { n: groups.length })
        }
        description={t("empty", "albPageDescription")}
      />

      {sources.data?.unread.map((kind) => (
        <Finding
          key={kind.crd}
          tone="warn"
          title={t("empty", "crdCouldNotBeListed", { crd: kind.crd })}
          verbatim={kind.reason}
        >
          {t("empty", "albUnreadNote")}
        </Finding>
      ))}

      <Section>
        <div className="mb-3">
          <FilterBox
            value={filter}
            onChange={setFilter}
            placeholder={t("action", "filterAlbPlaceholder")}
            label={t("action", "filterLoadBalancers")}
          />
        </div>

        {sources.isPending ? (
          <p className="text-xs text-fg-fnt">
            {t("empty", "readingIngresses")}
          </p>
        ) : groups.length === 0 ? (
          <p className="max-w-[68ch] text-[11.5px] text-fg-mut">
            {t("empty", "albNoIngressAsksForClass")}
          </p>
        ) : shown.length === 0 ? (
          <p className="text-[11.5px] text-fg-fnt">
            {t("empty", "nothingMatchesQuery", { query: filter })}
          </p>
        ) : (
          <div className="flex flex-col">
            {shown.map((group, index) => (
              <GroupRow
                key={group.name ?? `own-${index}`}
                group={group}
                bindings={sources.data?.bindings ?? []}
                openByDefault={group.worst !== null && troubled <= AUTO_OPEN}
                last={index === shown.length - 1}
              />
            ))}
          </div>
        )}
      </Section>
    </div>
  );
}

function groupState(group: AlbGroup): {
  key: keyof typeof en.empty;
  tone: Tone;
} {
  if (group.findings.some((finding) => finding.kind === "no-params")) {
    return { key: "namesSomethingAbsent", tone: "err" };
  }
  if (group.findings.some((finding) => finding.kind === "order-clash")) {
    return { key: "rulesOfEqualOrder", tone: "warn" };
  }
  if (group.findings.some((finding) => finding.kind === "disagree")) {
    return { key: "membersDisagree", tone: "warn" };
  }
  if (group.findings.some((finding) => finding.kind === "shared")) {
    return { key: "sharedAcrossNamespaces", tone: "warn" };
  }
  return { key: "serving", tone: "ok" };
}

function GroupRow({
  group,
  bindings,
  openByDefault,
  last,
}: {
  group: AlbGroup;
  bindings: Parameters<typeof bindingSummary>[0][];
  openByDefault: boolean;
  last: boolean;
}) {
  const t = useT();
  const state = groupState(group);
  const namespaces = [
    ...new Set(group.members.map((member) => member.ingress.namespace)),
  ];
  const hosts = [...new Set(group.members.flatMap((member) => member.hosts))];

  return (
    <TroubleRow
      title={
        group.name ?? (
          <span className="font-mono">
            {group.members[0]?.ingress.namespace}/
            {group.members[0]?.ingress.name}
          </span>
        )
      }
      copy={group.name ?? undefined}
      meta={
        <>
          {group.members.length}{" "}
          {group.members.length === 1 ? "Ingress" : "Ingresses"}
          {namespaces.length > 1 &&
            ` ${t("count", "acrossNamespaces", { n: namespaces.length })}`}
          {hosts.length > 0 && ` · ${t("count", "hosts", { n: hosts.length })}`}
          {group.name === null && ` · ${t("action", "itsOwnAlb")}`}
        </>
      }
      state={{ text: t("empty", state.key), tone: state.tone }}
      openByDefault={openByDefault}
      last={last}
    >
      <div className="flex flex-col gap-3">
        {group.params && <ParamsBlock group={group} />}
        <MembersBlock group={group} bindings={bindings} />
        {group.findings.map((finding, index) => (
          <FindingLine key={index} finding={finding} />
        ))}
      </div>
    </TroubleRow>
  );
}

/** What the class configured for this load balancer, which nothing resolved. */
function ParamsBlock({ group }: { group: AlbGroup }) {
  const t = useT();
  const params = group.params;
  if (!params) return null;
  return (
    <Chain>
      <Column label={t("columns", "classParams")}>
        <Cell under={params.loadBalancerName ?? undefined}>
          <ResourceRef
            kind="IngressClassParams"
            name={params.name}
            crd={INGRESS_CLASS_PARAMS_CRD}
            showKind={false}
          />
        </Cell>
      </Column>
      <Column label={t("columns", "facing")}>
        <Cell under={params.ipAddressType ?? undefined}>
          {params.scheme ?? t("action", "notSet")}
        </Cell>
      </Column>
      <Column label={t("columns", "certificate")}>
        <Cell
          title={params.certificateArn ?? undefined}
          under={params.sslPolicy ?? undefined}
        >
          {params.certificateArn
            ? (params.certificateArn.split("/").pop() ?? params.certificateArn)
            : t("action", "notSetHere")}
        </Cell>
      </Column>
      <Column label={t("columns", "reachableFrom")}>
        <Cell
          title={params.inboundCidrs.join(", ") || undefined}
          under={
            params.wafAcl ? `WAF ${params.wafAcl.split("/").pop()}` : undefined
          }
        >
          {params.inboundCidrs.length > 0
            ? params.inboundCidrs.join(", ")
            : t("action", "anywhereSubnetsAllow")}
        </Cell>
      </Column>
    </Chain>
  );
}

function MembersBlock({
  group,
  bindings,
}: {
  group: AlbGroup;
  bindings: Parameters<typeof bindingSummary>[0][];
}) {
  const t = useT();
  return (
    <div className="flex flex-col gap-1.5">
      {group.members.map((member) => {
        const backends = [
          ...new Set(
            member.ingress.rules.flatMap((rule) =>
              rule.paths.flatMap((path) =>
                path.backendService ? [path.backendService] : []
              )
            )
          ),
        ];
        return (
          <Chain key={`${member.ingress.namespace}/${member.ingress.name}`}>
            <Column label="Ingress">
              <Cell under={member.ingress.namespace}>
                <ResourceRef
                  kind={ResourceType.Ingress}
                  name={member.ingress.name}
                  namespace={member.ingress.namespace}
                  showKind={false}
                />
              </Cell>
            </Column>
            <Column label={t("columns", "order")}>
              <Cell warn={member.order === null && group.members.length > 1}>
                {member.order === null
                  ? t("action", "unset")
                  : String(member.order)}
              </Cell>
            </Column>
            <Column label={t("columns", "hosts")}>
              <Cell title={member.hosts.join(", ") || undefined}>
                {member.hosts.length > 0
                  ? member.hosts.join(", ")
                  : t("action", "anyHost")}
              </Cell>
            </Column>
            {/* The Service used to be the `under` line of the target group,
                which made the one object on this row a reader is most likely
                to want the only one they could not open. */}
            <Column label="Service">
              {backends.length === 0 ? (
                <Cell>
                  <span className="text-fg-fnt">{t("empty", "noBackend")}</span>
                </Cell>
              ) : (
                backends.map((backend) => (
                  <Cell key={backend}>
                    <ResourceRef
                      kind={ResourceType.Service}
                      name={backend}
                      namespace={member.ingress.namespace}
                      showKind={false}
                    />
                  </Cell>
                ))
              )}
            </Column>
            <Column label={t("columns", "targetGroups")}>
              {backends.length === 0 ? (
                <Cell>
                  <span className="text-fg-fnt">—</span>
                </Cell>
              ) : (
                backends.map((backend) => {
                  const bound = bindings.find(
                    (binding) =>
                      binding.namespace === member.ingress.namespace &&
                      boundService(binding) === backend
                  );
                  const failure = bound ? bindingFailure(bound) : null;
                  return (
                    <Cell
                      key={backend}
                      bad={failure !== null}
                      title={bound ? bindingSummary(bound) : undefined}
                    >
                      {bound ? (
                        <ObjectLink
                          kind="TargetGroupBinding"
                          name={bound.name}
                          namespace={bound.namespace}
                          crd={TARGET_GROUP_BINDING_CRD}
                          className="text-fg underline-offset-2 hover:underline"
                        >
                          {bindingSummary(bound)}
                        </ObjectLink>
                      ) : (
                        <span className="text-fg-fnt">
                          {t("empty", "noTargetGroupBinding")}
                        </span>
                      )}
                    </Cell>
                  );
                })
              )}
            </Column>
          </Chain>
        );
      })}
    </div>
  );
}

function FindingLine({ finding }: { finding: AlbFinding }) {
  const t = useT();
  switch (finding.kind) {
    case "shared":
      return (
        <Finding tone="warn" title={t("action", "albSharedTitle")}>
          {t("empty", "albSharedBody", {
            namespaces: finding.namespaces.join(", "),
          })}
        </Finding>
      );
    case "order-clash":
      return (
        <Finding
          tone="warn"
          title={t("action", "albOrderClashTitle", { order: finding.order })}
        >
          {t("empty", "albOrderClashBody", {
            members: finding.members.join(", "),
          })}
        </Finding>
      );
    case "disagree":
      return (
        <Finding
          tone="warn"
          title={t("action", "albDisagreeTitle", { field: finding.field })}
        >
          {finding.values.map((entry) => (
            <span key={entry.value} className="block">
              {t("empty", "albAsksFor", { by: entry.by, value: entry.value })}
            </span>
          ))}
          <span className="mt-1 block">{t("empty", "albDisagreeNote")}</span>
        </Finding>
      );
    case "no-params":
      return (
        <Finding
          tone="err"
          title={t("action", "albNoParamsTitle", { name: finding.named })}
        >
          {t("empty", "albNoParamsBody", { className: finding.className })}
        </Finding>
      );
    default:
      return null;
  }
}
