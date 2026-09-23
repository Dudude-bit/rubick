import { useMemo } from "react";
import { Link } from "react-router-dom";
import { Copy, Search, Zap } from "lucide-react";

import { ResourceRef } from "@/components/resources/ResourceRef";
import { Button } from "@/components/ui/button";
import { useAppInfo } from "@/hooks/useAppInfo";
import { useCopyToClipboard } from "@/hooks/useCopyToClipboard";
import {
  agentReport,
  hintFor,
  sayingWords,
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

/**
 * A hint in words. An inner {@link HintSaying} is chosen first: a count is
 * its own sentence, because no language can hand another a substring of
 * its own plural.
 */
/** The host of a custom search URL, or `null` when it is not one. */
function usableEngine(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:"
      ? parsed.host
      : null;
  } catch {
    return null;
  }
}

const words = (saying: HintSaying, t: T): string => sayingWords(saying, t);

export function MostLikelyPanel({
  pod,
  events,
  eventsError,
  onOpenTab,
}: {
  pod: PodInfo;
  events: EventInfo[];
  eventsError: string | null;
  /** The log tab is opened on a container, the way the Containers tab does. */
  onOpenTab: (tab: string, container?: string) => void;
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
  const version = useAppInfo();

  // A refused events read is not a pod with nothing wrong: three of the six
  // troubles are read from events, so the panel used to vanish rather than
  // say it could not look. Shown with the not-read line and no guess.
  if (!settings.showPanel) return null;
  if (!trouble && !eventsError) return null;
  const hint = trouble ? hintFor(trouble, pod, chain) : null;
  // A custom engine that is not an absolute URL is not an engine: the
  // search then built `?q=…` out of nothing, `openExternal` refused it and
  // silently put the query on the clipboard, and the line under the button
  // read "opens ; change the engine in Settings".
  const custom = usableEngine(settings.customUrl);
  const searchable = settings.engine !== "custom" || custom !== null;
  const site =
    settings.engine === "google"
      ? "google.com"
      : settings.engine === "duckduckgo"
        ? "duckduckgo.com"
        : (custom ?? "");
  const notRead = [...chain.notRead];
  if (eventsError)
    notRead.push(t("hints", "notReadEvents", { reason: eventsError }));

  const handleSearch = () => {
    if (!searchable || !trouble) return;
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
      guess: hint ? words(hint.headline, t) : null,
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
        {hint ? words(hint.headline, t) : t("hints", "guessUnknownUnread")}
      </h3>
      {(hint?.lines ?? []).map((line, index) => (
        <p key={index} className="mt-1 text-fg-mut">
          {words(line, t)}
        </p>
      ))}
      <p className="mt-1 text-[11px] text-fg-fnt">{t("hints", "notTested")}</p>
      {(hint?.checks.length ?? 0) > 0 ? (
        <ul className="mt-1.5 flex flex-col gap-0.5">
          {hint!.checks.map((check, index) => (
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
        <Button
          variant="outline"
          size="sm"
          onClick={handleSearch}
          disabled={!searchable}
        >
          <Search className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
          {t("hints", "googleIt")}
        </Button>
        <Button variant="outline" size="sm" onClick={handleCopy}>
          <Copy className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
          {t("hints", "copyForAgent")}
        </Button>
        <span className="text-[11px] text-fg-fnt">
          {searchable
            ? t("hints", "searchOpens", { site })
            : t("hints", "searchNoEngine")}
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
  onOpenTab: (tab: string, container?: string) => void;
}) {
  const t = useT();
  const text = words(check.says, t);
  if (check.to === null) return <span className="text-fg-mut">{text}</span>;
  if (check.to.kind === "tab") {
    const tab = check.to.tab;
    const container = check.to.container;
    return (
      <button
        type="button"
        className="text-left text-info hover:underline"
        onClick={() => onOpenTab(tab, container)}
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
