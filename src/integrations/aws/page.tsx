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
import { Link } from "react-router-dom";

import { Section, SectionHeader } from "@/components/ui/section";
import { ResourceType } from "@/lib/resource-registry";
import { getResourceDetailUrl } from "@/lib/navigation-utils";
import { crdObjectPath } from "../kit";
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
import {
  INGRESS_CLASS_PARAMS_CRD,
  TARGET_GROUP_BINDING_CRD,
  bindingFailure,
  bindingSummary,
  boundService,
} from "./model";

/** Past this many groups with a finding, nothing opens itself. */
const AUTO_OPEN = 6;

export default function AwsLoadBalancerPage() {
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
          Could not read this cluster&rsquo;s Ingresses
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
            : `${groups.length} ${groups.length === 1 ? "load balancer" : "load balancers"}`
        }
        description="One row per ALB rather than per Ingress — because this controller is the one that puts several Ingresses, from several namespaces, on the same load balancer."
      />

      {sources.data?.unread.map((kind) => (
        <Finding
          key={kind.crd}
          tone="warn"
          title={
            <>
              <span className="font-mono">{kind.crd}</span> could not be listed
            </>
          }
          verbatim={kind.reason}
        >
          Groups are still drawn from the Ingresses themselves; what is missing
          is what the class configured for them.
        </Finding>
      ))}

      <Section>
        <div className="mb-3">
          <FilterBox
            value={filter}
            onChange={setFilter}
            placeholder="Filter by group, Ingress or host…"
            label="Filter load balancers"
          />
        </div>

        {sources.isPending ? (
          <p className="text-xs text-fg-fnt">Reading the Ingresses…</p>
        ) : groups.length === 0 ? (
          <p className="max-w-[68ch] text-[11.5px] text-fg-mut">
            No Ingress in this cluster asks for the{" "}
            <span className="font-mono">alb</span> class, so this controller is
            running no load balancer here. Its CRDs may still be installed —
            that is what put this page in the sidebar.
          </p>
        ) : shown.length === 0 ? (
          <p className="text-[11.5px] text-fg-fnt">
            Nothing matches <span className="font-mono">{filter}</span>.
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

function groupState(group: AlbGroup): { text: string; tone: Tone } {
  if (group.findings.some((finding) => finding.kind === "no-params")) {
    return { text: "names something absent", tone: "err" };
  }
  if (group.findings.some((finding) => finding.kind === "order-clash")) {
    return { text: "rules of equal order", tone: "warn" };
  }
  if (group.findings.some((finding) => finding.kind === "disagree")) {
    return { text: "members disagree", tone: "warn" };
  }
  if (group.findings.some((finding) => finding.kind === "shared")) {
    return { text: "shared across namespaces", tone: "warn" };
  }
  return { text: "serving", tone: "ok" };
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
      meta={
        <>
          {group.members.length}{" "}
          {group.members.length === 1 ? "Ingress" : "Ingresses"}
          {namespaces.length > 1 && ` across ${namespaces.length} namespaces`}
          {hosts.length > 0 &&
            ` · ${hosts.length} ${hosts.length === 1 ? "host" : "hosts"}`}
          {group.name === null && " · its own ALB"}
        </>
      }
      state={groupState(group)}
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
  const params = group.params;
  if (!params) return null;
  return (
    <Chain>
      <Column label="Class params">
        <Cell under={params.loadBalancerName ?? undefined}>
          <Link
            className="font-mono text-fg underline-offset-2 hover:underline"
            to={crdObjectPath(INGRESS_CLASS_PARAMS_CRD, null, params.name)}
          >
            {params.name}
          </Link>
        </Cell>
      </Column>
      <Column label="Facing">
        <Cell under={params.ipAddressType ?? undefined}>
          {params.scheme ?? "not set"}
        </Cell>
      </Column>
      <Column label="Certificate">
        <Cell
          title={params.certificateArn ?? undefined}
          under={params.sslPolicy ?? undefined}
        >
          {params.certificateArn
            ? (params.certificateArn.split("/").pop() ?? params.certificateArn)
            : "not set here"}
        </Cell>
      </Column>
      <Column label="Reachable from">
        <Cell
          title={params.inboundCidrs.join(", ") || undefined}
          under={
            params.wafAcl ? `WAF ${params.wafAcl.split("/").pop()}` : undefined
          }
        >
          {params.inboundCidrs.length > 0
            ? params.inboundCidrs.join(", ")
            : "anywhere the subnets allow"}
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
                <Link
                  className="font-mono text-fg underline-offset-2 hover:underline"
                  to={getResourceDetailUrl(
                    ResourceType.Ingress,
                    member.ingress.name,
                    member.ingress.namespace
                  )}
                >
                  {member.ingress.name}
                </Link>
              </Cell>
            </Column>
            <Column label="Order">
              <Cell warn={member.order === null && group.members.length > 1}>
                {member.order === null ? "unset" : String(member.order)}
              </Cell>
            </Column>
            <Column label="Hosts">
              <Cell title={member.hosts.join(", ") || undefined}>
                {member.hosts.length > 0 ? member.hosts.join(", ") : "any host"}
              </Cell>
            </Column>
            <Column label="Target groups">
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
                      under={backend}
                      title={bound ? bindingSummary(bound) : undefined}
                    >
                      {bound ? (
                        <Link
                          className="text-fg underline-offset-2 hover:underline"
                          to={crdObjectPath(
                            TARGET_GROUP_BINDING_CRD,
                            bound.namespace,
                            bound.name
                          )}
                        >
                          {bindingSummary(bound)}
                        </Link>
                      ) : (
                        <span className="text-fg-fnt">
                          no TargetGroupBinding
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
  switch (finding.kind) {
    case "shared":
      return (
        <Finding tone="warn" title="One load balancer, several namespaces">
          <span className="font-mono">{finding.namespaces.join(", ")}</span> all
          put Ingresses on this ALB. Their rules are concatenated into one
          listener, so a path added in one namespace can shadow a path in
          another, and the certificate, scheme and WAF are shared — none of
          which is visible from any of the Ingresses&rsquo; own pages.
        </Finding>
      );
    case "order-clash":
      return (
        <Finding
          tone="warn"
          title={
            <>
              Two Ingresses claim order{" "}
              <span className="font-mono">{finding.order}</span>
            </>
          }
        >
          <span className="font-mono">{finding.members.join(", ")}</span> ask
          for the same position in the listener&rsquo;s rule list. The
          controller will pick one; nothing in these objects says which, and the
          one that loses has its rules evaluated after the other&rsquo;s.
        </Finding>
      );
    case "disagree":
      return (
        <Finding
          tone="warn"
          title={
            <>
              Members disagree about{" "}
              <span className="font-mono">{finding.field}</span>
            </>
          }
        >
          {finding.values.map((entry) => (
            <span key={entry.value} className="block">
              <span className="font-mono">{entry.by}</span> asks for{" "}
              <span className="font-mono">{entry.value}</span>
            </span>
          ))}
          <span className="mt-1 block">
            A load balancer has one of these. One of the two is being discarded,
            and the controller decides which.
          </span>
        </Finding>
      );
    case "no-params":
      return (
        <Finding
          tone="err"
          title={
            <>
              No <span className="font-mono">IngressClassParams</span> named{" "}
              <span className="font-mono">{finding.named}</span>
            </>
          }
        >
          The <span className="font-mono">{finding.className}</span> class
          points its <span className="font-mono">spec.parameters</span> at it
          and there is none in the cluster, so every default it was meant to set
          — scheme, certificate, subnets, WAF — is unset instead.
        </Finding>
      );
    default:
      return null;
  }
}
