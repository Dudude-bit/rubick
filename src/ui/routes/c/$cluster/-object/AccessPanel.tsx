import type { ReactNode } from "react";
import {
  ArrowRight,
  Ban,
  ChevronRight,
  EyeOff,
  Globe,
  ShieldAlert,
  Users,
} from "lucide-react";

import { ResourceRef } from "@/components/object/ResourceRef";
import { TextSkeleton } from "@/components/ui/skeleton";
import { Unknown } from "@/components/ui/unknown";
import type { BindingInfo } from "@/generated/types";
import { useNamespaceScope } from "@/hooks/useNamespaceScope";
import { useT, type T } from "@/i18n/useT";
import { accessKind } from "@/lib/access-kinds";
import { crdOf } from "./ownership";
import {
  bindingsOf,
  escalatingVerbs,
  grantsTo,
  roleTarget,
  rulesTable,
  subjectTarget,
  type Account,
  type Grant,
  type RbacTarget,
} from "./rbac";
import {
  useBindingLists,
  useRoleReadings,
  type BindingLists,
  type RoleReading,
} from "./access-reading";
import { WordTable } from "./WordTable";

type Heading = (title: string, count?: ReactNode) => ReactNode;

/**
 * Who may do what, read from the other side of the bindings: what a
 * ServiceAccount is granted, and whom a Role or ClusterRole is granted to.
 * Drawn by the object page and the peek alike.
 */
export function AccessPanel({
  kind,
  name,
  namespace,
  heading,
}: {
  kind: string;
  name: string;
  namespace: string | null;
  heading: Heading;
}) {
  if (kind === "ServiceAccount" && namespace)
    return <AccountGrants account={{ name, namespace }} heading={heading} />;
  if (kind === "Role" && namespace)
    return <RoleBound role={{ kind, name, namespace }} heading={heading} />;
  if (kind === "ClusterRole")
    return (
      <RoleBound role={{ kind, name, namespace: null }} heading={heading} />
    );
  return null;
}

/** The groups every ServiceAccount, or everyone signed in, belongs to. */
const BROAD = new Set<Grant["reach"]>(["everyAccount", "authenticated"]);

function AccountGrants({
  account,
  heading,
}: {
  account: Account;
  heading: Heading;
}) {
  const t = useT();
  const lists = useBindingLists([account.namespace], true);
  const grants = grantsTo(lists.bindings, account);
  const targets = grants.map(({ binding }) =>
    roleTarget(binding.roleRef, binding.namespace)
  );
  const roles = useRoleReadings(
    targets.filter((target): target is RbacTarget => target !== null)
  );
  const readings = new Map<string, RoleReading | undefined>();
  let at = 0;
  for (const target of targets)
    if (target) readings.set(keyOf(target), roles.readings[at++]);

  const named = grants.filter((grant) => !BROAD.has(grant.reach));
  const broad = grants.filter((grant) => BROAD.has(grant.reach));
  const row = (grant: Grant) => {
    const target = roleTarget(grant.binding.roleRef, grant.binding.namespace);
    return (
      <GrantRow
        key={`${grant.binding.kind}/${grant.binding.namespace}/${grant.binding.name}`}
        grant={grant}
        account={account}
        target={target}
        reading={target ? readings.get(keyOf(target)) : undefined}
        onRetry={roles.retry}
      />
    );
  };

  return (
    <div className="flex flex-col gap-2">
      {heading(t("rbac", "mayDo"), known(lists) ? grants.length : undefined)}
      {lists.loading ? (
        <TextSkeleton lines={3} />
      ) : (
        <>
          {named.map(row)}
          {broad.length > 0 && (
            <details className="group">
              <summary className="inline-flex cursor-pointer select-none items-center gap-1 rounded-md px-1 py-0.5 text-xs text-fg-mut hover:bg-hover hover:text-fg">
                <ChevronRight
                  className="h-3 w-3 flex-none transition-transform duration-200 group-open:rotate-90 motion-reduce:transition-none"
                  aria-hidden
                />
                {t("rbac", "broadGrants", { n: broad.length })}
              </summary>
              <div className="mt-2 flex flex-col gap-2">{broad.map(row)}</div>
            </details>
          )}
          <Verdict
            found={grants.length}
            lists={lists}
            none={t("rbac", "noGrants", { namespace: account.namespace })}
          />
        </>
      )}
      <NotLookedAt>{t("rbac", "otherNamespaces")}</NotLookedAt>
    </div>
  );
}

/** A count is the total only when nothing was left unread. */
const known = (lists: BindingLists) =>
  !lists.loading && lists.gaps.length === 0;

const keyOf = (target: RbacTarget) =>
  `${target.kind}/${target.namespace ?? ""}/${target.name}`;

function GrantRow({
  grant,
  account,
  target,
  reading,
  onRetry,
}: {
  grant: Grant;
  account: Account;
  target: RbacTarget | null;
  reading: RoleReading | undefined;
  onRetry: () => void;
}) {
  const t = useT();
  const { binding } = grant;
  const escalates =
    reading?.state === "read" &&
    reading.rules.some((rule) => escalatingVerbs(rule).length > 0);
  return (
    <div className="flex flex-col gap-1.5 border-t border-hair pt-2 first:border-t-0 first:pt-0">
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs">
        <BindingRef binding={binding} />
        <ArrowRight className="h-3 w-3 flex-none text-fg-fnt" aria-hidden />
        {target ? (
          <ResourceRef
            kind={target.kind}
            name={target.name}
            namespace={target.namespace}
            crd={crdOf(target)}
          />
        ) : (
          <span className="font-mono text-fg-mut">
            {binding.roleRef.kind} {binding.roleRef.name}
          </span>
        )}
        {escalates && (
          <ShieldAlert
            className="h-3.5 w-3.5 flex-none text-err"
            role="img"
            aria-label={t("rbac", "escalates")}
          >
            <title>{t("rbac", "escalates")}</title>
          </ShieldAlert>
        )}
        <Where binding={binding} t={t} />
        {grant.reach !== "account" && (
          <span className="inline-flex items-center gap-1 text-[11px] text-fg-mut">
            <Users className="h-3 w-3" aria-hidden />
            {t("rbac", "throughGroup", {
              group: groupName(grant.reach, account),
            })}
          </span>
        )}
      </div>
      {target && (
        <RoleRules target={target} reading={reading} onRetry={onRetry} />
      )}
    </div>
  );
}

function groupName(reach: Grant["reach"], account: Account): string {
  if (reach === "namespaceGroup")
    return `system:serviceaccounts:${account.namespace}`;
  if (reach === "everyAccount") return "system:serviceaccounts";
  return "system:authenticated";
}

function RoleRules({
  target,
  reading,
  onRetry,
}: {
  target: RbacTarget;
  reading: RoleReading | undefined;
  onRetry: () => void;
}) {
  const t = useT();
  if (reading === undefined) return <TextSkeleton lines={2} />;
  if (reading.state === "missing")
    return (
      <p className="flex items-start gap-1.5 text-xs text-warn">
        <Ban className="mt-0.5 h-3 w-3 flex-none" aria-hidden />
        {t("rbac", "roleMissing", { kind: target.kind, name: target.name })}
      </p>
    );
  if (reading.state === "unread")
    return (
      <Unknown
        question={t("rbac", "couldNotReadRole", {
          kind: target.kind,
          name: target.name,
        })}
        error={reading.error}
        onRetry={onRetry}
      />
    );
  return (
    <WordTable
      table={rulesTable(reading.rules, t)}
      emptyMessage={t("rbac", "noRules")}
    />
  );
}

function BindingRef({ binding }: { binding: BindingInfo }) {
  return (
    <ResourceRef
      kind={binding.kind}
      name={binding.name}
      namespace={binding.namespace}
    />
  );
}

function Where({ binding, t }: { binding: BindingInfo; t: T }) {
  return binding.namespace ? (
    <span className="text-[11px] text-fg-fnt">
      {t("rbac", "inNamespace", { namespace: binding.namespace })}
    </span>
  ) : (
    <span className="inline-flex items-center gap-1 text-[11px] text-fg-mut">
      <Globe className="h-3 w-3" aria-hidden />
      {t("rbac", "clusterWide")}
    </span>
  );
}

/** "None" only where every list was read whole; otherwise what was not. */
function Verdict({
  found,
  lists,
  none,
}: {
  found: number;
  lists: BindingLists;
  none: string;
}) {
  const t = useT();
  const { gaps } = lists;
  if (gaps.length === 0)
    return found === 0 ? <p className="text-xs text-fg-mut">{none}</p> : null;
  return (
    <div className="flex flex-col gap-1.5">
      <p className="text-xs text-warn">
        {found === 0
          ? t("rbac", "noneFoundUnread")
          : t("rbac", "notEverythingRead")}
      </p>
      {gaps.map((gap) => {
        const label = accessKind(gap.kind)!.displayPlural;
        return (
          <Unknown
            key={`${gap.kind}/${gap.namespace ?? ""}`}
            question={
              gap.namespace
                ? t("empty", "couldNotReadInNamespace", {
                    label,
                    namespace: gap.namespace,
                  })
                : t("rbac", "couldNotReadClusterWide", { label })
            }
            error={gap.error}
            onRetry={lists.retry}
          />
        );
      })}
    </div>
  );
}

function NotLookedAt({ children }: { children: ReactNode }) {
  return (
    <p className="flex items-start gap-1.5 text-[11px] text-fg-fnt">
      <EyeOff className="mt-px h-3 w-3 flex-none" aria-hidden />
      {children}
    </p>
  );
}

function RoleBound({
  role,
  heading,
}: {
  role: {
    kind: "Role" | "ClusterRole";
    name: string;
    namespace: string | null;
  };
  heading: Heading;
}) {
  const t = useT();
  const scope = useNamespaceScope();
  const cluster = role.kind === "ClusterRole";
  // A ClusterRole can be granted by a RoleBinding anywhere; they are read
  // where the window looks, which is every namespace unless some are picked.
  const namespaces = role.namespace ? [role.namespace] : scope.wire;
  const lists = useBindingLists(namespaces, cluster);
  const bindings = bindingsOf(lists.bindings, role);
  const none = role.namespace
    ? t("rbac", "notBoundRole", { namespace: role.namespace })
    : namespaces
      ? t("rbac", "notBoundClusterRoleIn", {
          namespaces: namespaces.join(", "),
        })
      : t("rbac", "notBoundClusterRole");

  return (
    <div className="flex flex-col gap-2">
      {heading(
        t("rbac", "boundTo"),
        known(lists) ? bindings.length : undefined
      )}
      {lists.loading ? (
        <TextSkeleton lines={3} />
      ) : (
        <>
          {bindings.map((binding) => (
            <div
              key={`${binding.kind}/${binding.namespace}/${binding.name}`}
              className="flex flex-col gap-1 border-t border-hair pt-2 first:border-t-0 first:pt-0"
            >
              <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs">
                <BindingRef binding={binding} />
                <Where binding={binding} t={t} />
              </div>
              <Subjects binding={binding} />
            </div>
          ))}
          <Verdict found={bindings.length} lists={lists} none={none} />
        </>
      )}
      {cluster && namespaces && (
        <NotLookedAt>
          {t("rbac", "readOnlyIn", { namespaces: namespaces.join(", ") })}
        </NotLookedAt>
      )}
    </div>
  );
}

function Subjects({ binding }: { binding: BindingInfo }) {
  const t = useT();
  if (binding.subjects.length === 0)
    return <p className="text-xs text-fg-fnt">{t("rbac", "noSubjects")}</p>;
  return (
    <ul className="flex flex-col gap-0.5 pl-1">
      {binding.subjects.map((subject) => {
        const target = subjectTarget(subject, binding.namespace);
        return (
          <li
            key={`${subject.kind}/${subject.namespace ?? ""}/${subject.name}`}
            className="grid grid-cols-[minmax(0,110px)_minmax(0,1fr)] items-baseline gap-2 text-xs"
          >
            <span className="text-[11px] text-fg-fnt">{subject.kind}</span>
            {target ? (
              <ResourceRef
                kind={target.kind}
                name={target.name}
                namespace={target.namespace}
                showKind={false}
                showNamespace={target.namespace !== binding.namespace}
              />
            ) : (
              <span className="min-w-0 break-all font-mono text-fg">
                {subject.name}
              </span>
            )}
          </li>
        );
      })}
    </ul>
  );
}
