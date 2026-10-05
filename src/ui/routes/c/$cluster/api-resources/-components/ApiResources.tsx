import { useQuery } from "@tanstack/react-query";
import {
  AlertTriangle,
  Ban,
  FolderOpen,
  Globe,
  Search,
  XCircle,
} from "lucide-react";
import { useMemo, useState } from "react";

import { catalogQuery } from "../../-object/served";
import { catalogGroups, listable, type CatalogGroup } from "./catalog-groups";
import { KindIcon } from "@/components/object/KindIcon";
import { Button } from "@/components/ui/button";
import { RouteLink } from "@/components/ui/route-link";
import { Section, SectionHeader } from "@/components/ui/section";
import { TextSkeleton } from "@/components/ui/skeleton";
import type { CatalogEntry, UnreadGroup } from "@/generated/types";
import { useT } from "@/i18n/useT";
import { errorToShow } from "@/lib/error-utils";
import { servedListLink } from "@/lib/links";
import { cn } from "@/lib/utils";
import { useClusterStore } from "@/stores/clusterStore";

/** Every kind the cluster serves, by API group, each a way to its list. */
export function ApiResources() {
  const t = useT();
  const isConnected = useClusterStore((state) => state.isConnected);
  const catalog = useQuery({ ...catalogQuery(), enabled: isConnected });
  const [filter, setFilter] = useState("");
  const shown = useMemo(
    () => (catalog.data ? catalogGroups(catalog.data, filter) : null),
    [catalog.data, filter]
  );

  return (
    <div className="flex max-w-6xl flex-col gap-[18px]">
      <SectionHeader
        title={t("nav", "apiResources")}
        count={
          shown
            ? `${t("count", "servedKinds", { n: shown.kinds })} · ${t("count", "apiGroups", { n: shown.groups.length })}`
            : undefined
        }
        description={t("apiResources", "description")}
        actions={
          <div className="flex h-6 items-center gap-1.5 rounded px-1.5 text-fg-fnt transition-colors hover:bg-hover focus-within:bg-hover">
            <Search className="h-3 w-3 shrink-0" aria-hidden="true" />
            <input
              type="text"
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
              aria-label={t("apiResources", "filter")}
              placeholder={t("apiResources", "filter")}
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
              className="w-44 bg-transparent text-[11px] text-fg outline-hidden placeholder:text-fg-fnt"
            />
          </div>
        }
      />
      {!isConnected ? (
        <p className="text-xs text-fg-mut">
          {t("apiResources", "notConnected")}
        </p>
      ) : catalog.isError && !catalog.data ? (
        <div className="flex flex-col items-start gap-1.5">
          <p className="flex items-center gap-2 text-xs font-medium text-err">
            <XCircle className="h-3.5 w-3.5" aria-hidden="true" />
            {t("apiResources", "unreadTitle")}
          </p>
          <p className="text-[11px] text-fg-fnt">
            {errorToShow(catalog.error)}
          </p>
          <Button
            variant="link"
            size="sm"
            onClick={() => void catalog.refetch()}
          >
            {t("apiResources", "retry")}
          </Button>
        </div>
      ) : !shown ? (
        <TextSkeleton lines={8} />
      ) : (
        <>
          {shown.kinds === 0 && filter.trim() !== "" && (
            <p className="text-xs text-fg-mut">
              {shown.unread.length > 0
                ? t("apiResources", "noMatchAnswered", {
                    filter: filter.trim(),
                  })
                : t("apiResources", "noMatch", { filter: filter.trim() })}
            </p>
          )}
          {shown.groups.map((group) => (
            <GroupSection key={group.group || "core"} group={group} />
          ))}
          {shown.unread.map((group) => (
            <UnreadSection key={group.group} group={group} />
          ))}
        </>
      )}
    </div>
  );
}

const groupName = (group: string, t: ReturnType<typeof useT>) =>
  group || t("apiResources", "core");

function GroupSection({ group }: { group: CatalogGroup }) {
  const t = useT();
  return (
    <Section aria-label={groupName(group.group, t)}>
      <h3 className="flex items-baseline gap-2 border-b border-hair pb-1 font-mono text-xs text-fg-mid">
        {groupName(group.group, t)}
        <span className="font-sans text-[11px] tabular-nums text-fg-fnt">
          {group.entries.length}
        </span>
      </h3>
      <ul className="grid grid-cols-1 gap-x-6 sm:grid-cols-2">
        {group.entries.map((entry) => (
          <KindRow key={`${entry.group}/${entry.plural}`} entry={entry} />
        ))}
      </ul>
    </Section>
  );
}

function KindRow({ entry }: { entry: CatalogEntry }) {
  const t = useT();
  const version = entry.group
    ? `${entry.group}/${entry.version}`
    : entry.version;
  const ScopeIcon = entry.namespaced ? FolderOpen : Globe;
  const name = (
    <>
      <KindIcon kind={entry.kind} className="h-3.5 w-3.5" />
      <span className="truncate font-mono text-xs text-fg" title={entry.kind}>
        {entry.kind}
      </span>
    </>
  );
  return (
    <li className="flex min-h-7 items-center gap-2 px-1">
      {listable(entry) ? (
        <RouteLink
          {...servedListLink(entry)}
          className="-mx-1 flex min-w-0 items-center gap-2 rounded px-1 hover:bg-hover"
        >
          {name}
        </RouteLink>
      ) : (
        <span className="flex min-w-0 items-center gap-2">{name}</span>
      )}
      <span
        // Gives way first: the kind is what the row is read by.
        className="min-w-0 shrink-[100] truncate font-mono text-[11px] text-fg-fnt"
        title={version}
      >
        {version}
      </span>
      <span className="ml-auto flex flex-none items-center gap-2 text-[11px]">
        {!listable(entry) && (
          <span className="inline-flex items-center gap-1 text-fg-fnt">
            <Ban className="h-3 w-3" aria-hidden="true" />
            {t("apiResources", "notListable")}
          </span>
        )}
        <span
          className={cn(
            "inline-flex items-center gap-1",
            entry.namespaced ? "text-fg-mut" : "text-info"
          )}
        >
          <ScopeIcon className="h-3 w-3" aria-hidden="true" />
          {entry.namespaced
            ? t("apiResources", "namespaced")
            : t("apiResources", "clusterWide")}
        </span>
      </span>
    </li>
  );
}

/** A group nobody could read stays on the page, with why. */
function UnreadSection({ group }: { group: UnreadGroup }) {
  const t = useT();
  return (
    <Section aria-label={group.group}>
      <h3 className="flex items-center gap-2 border-b border-hair pb-1 font-mono text-xs text-warn">
        <AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" />
        {group.group}
      </h3>
      <p className="text-xs text-fg-mut">{t("apiResources", "groupUnread")}</p>
      <p className="font-mono text-[11px] text-fg-fnt">{group.message}</p>
    </Section>
  );
}
