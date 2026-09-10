import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { Copy, Search, Zap } from "lucide-react";

import { ResourceRef } from "@/components/resources/ResourceRef";
import { Button } from "@/components/ui/button";
import { useCopyToClipboard } from "@/hooks/useCopyToClipboard";
import { commands } from "@/lib/commands";
import {
  agentReport,
  hintFor,
  searchQuery,
  searchUrl,
  troubleOf,
  type Check,
  type HintSaying,
  type MountedConfig,
} from "@/lib/hints";
import { openExternal } from "@/lib/open-external";
import { useClusterStore } from "@/stores/clusterStore";
import { useHintSettingsStore } from "@/stores/hintSettingsStore";
import { useHintChain } from "@/components/pod/useHintChain";
import { useT, type T } from "@/i18n/useT";
import type { EventInfo, PodInfo } from "@/generated/types";

const words = (saying: HintSaying, t: T) =>
  t("hints", saying.key, saying.values ?? {});

export function MostLikelyPanel({
  pod,
  events,
  eventsError,
  onOpenTab,
}: {
  pod: PodInfo;
  events: EventInfo[];
  eventsError: string | null;
  onOpenTab: (tab: string) => void;
}) {
  const t = useT();
  const copy = useCopyToClipboard();
  const settings = useHintSettingsStore();
  const context = useClusterStore((s) => s.currentContext) ?? "";
  const trouble = useMemo(() => troubleOf(pod, events), [pod, events]);
  const { chain, logLines, logContainer, previous } = useHintChain(
    pod,
    trouble,
    settings.showPanel
  );
  const version = useQuery({
    queryKey: ["app-info"],
    queryFn: () => commands.getAppInfo(),
    staleTime: Infinity,
  });

  if (!settings.showPanel || !trouble) return null;
  const hint = hintFor(trouble, pod, chain);
  const site =
    settings.engine === "google"
      ? "google.com"
      : settings.engine === "duckduckgo"
        ? "duckduckgo.com"
        : settings.customUrl;
  const notRead = [...chain.notRead];
  if (eventsError)
    notRead.push(t("hints", "notReadEvents", { reason: eventsError }));

  const handleSearch = () => {
    const query = searchQuery(trouble, pod, chain.address, settings.stripNames);
    void openExternal(
      searchUrl(settings.engine, settings.customUrl, query),
      site,
      t
    );
  };
  const handleCopy = () => {
    const mounts: MountedConfig[] = pod.volumes.flatMap((volume) =>
      volume.refs
        .filter((ref) => ref.kind === "ConfigMap" || ref.kind === "Secret")
        .map((ref) => ({
          kind: ref.kind,
          name: ref.name,
          path: volume.mounts[0]?.path ?? "",
          keys: null,
        }))
    );
    const text = agentReport({
      version: version.data?.version ?? "",
      context,
      at: new Date().toISOString(),
      pod,
      trouble,
      logLines: settings.includeLogLines ? logLines : [],
      logContainer,
      logPrevious: previous,
      events,
      chain: { ...chain, notRead },
      mounts,
      guess: words(hint.headline, t),
    });
    copy(text, t("hints", "copiedForAgent", { n: text.length }));
  };

  return (
    <section
      className="rounded border border-warn/40 bg-canvas px-3 py-2 text-xs"
      aria-label={t("hints", "mostLikely")}
      data-testid="most-likely"
    >
      <h3 className="flex items-center gap-1.5 font-medium text-fg">
        <Zap className="h-3.5 w-3.5 text-warn" aria-hidden="true" />
        {words(hint.headline, t)}
      </h3>
      {hint.lines.map((line, index) => (
        <p key={index} className="mt-1 text-fg-mut">
          {words(line, t)}
        </p>
      ))}
      <p className="mt-1 text-[11px] text-fg-fnt">{t("hints", "notTested")}</p>
      {hint.checks.length > 0 ? (
        <ul className="mt-1.5 flex flex-col gap-0.5">
          {hint.checks.map((check, index) => (
            <li key={index} className="flex items-baseline gap-1.5">
              <span className="text-fg-fnt" aria-hidden="true">
                ·
              </span>
              <CheckRow check={check} onOpenTab={onOpenTab} />
            </li>
          ))}
        </ul>
      ) : null}
      {notRead.length > 0 ? (
        <p className="mt-1.5 text-[11px] text-warn">
          {t("count", "notReadList", { list: notRead.join("; ") })}
        </p>
      ) : null}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Button variant="outline" size="sm" onClick={handleSearch}>
          <Search className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
          {t("hints", "googleIt")}
        </Button>
        <Button variant="outline" size="sm" onClick={handleCopy}>
          <Copy className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
          {t("hints", "copyForAgent")}
        </Button>
        <span className="text-[11px] text-fg-fnt">
          {t("hints", "searchOpens", { site })}
        </span>
      </div>
    </section>
  );
}

function CheckRow({
  check,
  onOpenTab,
}: {
  check: Check;
  onOpenTab: (tab: string) => void;
}) {
  const t = useT();
  const text = words(check.says, t);
  if (check.to === null) return <span className="text-fg-mut">{text}</span>;
  if (check.to.kind === "tab") {
    const tab = check.to.tab;
    return (
      <button
        type="button"
        className="text-left text-info hover:underline"
        onClick={() => onOpenTab(tab)}
      >
        {text}
      </button>
    );
  }
  if (check.to.objectKind === "Node" && check.to.name === "") {
    return (
      <Link to="/nodes" className="text-info hover:underline">
        {text}
      </Link>
    );
  }
  return (
    <span className="flex flex-wrap items-baseline gap-1.5 text-fg-mut">
      <ResourceRef
        kind={check.to.objectKind}
        name={check.to.name}
        namespace={check.to.namespace ?? undefined}
      />
      {text}
    </span>
  );
}
