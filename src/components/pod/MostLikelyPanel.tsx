import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { Copy, Search, Zap } from "lucide-react";

import { ResourceRef } from "@/components/resources/ResourceRef";
import { Button } from "@/components/ui/button";
import { useCopyToClipboard } from "@/hooks/useCopyToClipboard";
import { commands } from "@/lib/commands";
import { normalizeTauriError } from "@/lib/error-utils";
import {
  addressIn,
  agentReport,
  hintFor,
  namespaceOf,
  searchQuery,
  searchUrl,
  troubleOf,
  type Chain,
  type Check,
  type HintSaying,
  type MountedConfig,
  type Trouble,
} from "@/lib/hints";
import { openExternal } from "@/lib/open-external";
import { useClusterStore } from "@/stores/clusterStore";
import { useHintSettingsStore } from "@/stores/hintSettingsStore";
import { useT, type T } from "@/i18n/useT";
import type { EventInfo, PodInfo } from "@/generated/types";

const LOG_LINES = 40;
const STALE = 15_000;

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

const words = (saying: HintSaying, t: T): string => {
  const values: Record<string, string | number> = {};
  for (const [name, value] of Object.entries(saying.values ?? {}))
    values[name] =
      typeof value === "object" && value !== null ? words(value, t) : value;
  return t("hints", saying.key, values);
};

/**
 * Everything the sentence is built from: the pod's events, the last lines
 * of the troubled container, and the Service behind the address those
 * lines named, each read separately so a refusal on one is one line in
 * "Not read" rather than a panel that does not appear.
 */
function useChain(pod: PodInfo, trouble: Trouble | null, wantLogs: boolean) {
  const t = useT();
  const context = useClusterStore((s) => s.currentContext);
  const logContainer =
    trouble && "container" in trouble && trouble.container
      ? trouble.container
      : null;
  const previous = trouble?.reason === "crashLoop";

  const logs = useQuery({
    queryKey: [
      context,
      "hints",
      "logs",
      pod.namespace,
      pod.name,
      logContainer,
      previous,
      pod.restartCount,
    ],
    queryFn: async () => {
      try {
        const lines = await commands.getPodLogs(
          pod.name,
          pod.namespace,
          logContainer,
          LOG_LINES,
          null,
          previous
        );
        return lines.map((line) => line.raw || line.message);
      } catch (error) {
        throw new Error(normalizeTauriError(error), { cause: error });
      }
    },
    enabled: wantLogs && logContainer !== null,
    staleTime: STALE,
    retry: false,
  });

  // The pod's own namespace is enough for `db.shop`: the cross-namespace
  // form every Kubernetes reader writes, which was called outside the
  // cluster and gated off the Service lookup.
  const namespaces = useMemo(() => [pod.namespace], [pod.namespace]);
  const address = useMemo(
    () => addressIn(logs.data ?? [], namespaces),
    [logs.data, namespaces]
  );
  const inCluster = address?.where === "inCluster" ? address : null;

  const services = useQuery({
    queryKey: [context, "hints", "services", pod.namespace],
    queryFn: () =>
      commands.listServices({
        namespace: pod.namespace,
        labelSelector: null,
        fieldSelector: null,
        limit: null,
        serviceType: null,
      }),
    enabled: inCluster !== null,
    staleTime: STALE,
    retry: false,
  });
  /**
   * The Service the address names, matched with its namespace.
   *
   * `shop-db-rw.billing.svc.cluster.local` was matched on the bare name
   * against this namespace's Services, so a same-named Service next door
   * was reported — with its endpoint count — as the thing behind an
   * address in another namespace.
   */
  const service = useMemo(() => {
    if (!inCluster || !services.data) return null;
    const host = inCluster.host.toLowerCase();
    const labels = namespaceOf(host, pod.namespace);
    // Not this namespace: the app did not list that one, so it has not
    // looked rather than found nothing.
    if (labels.namespace !== pod.namespace) return null;
    const bare = labels.name;
    return (
      services.data.find(
        (svc) =>
          svc.clusterIp === inCluster.host ||
          svc.name.toLowerCase() === host ||
          (labels.qualified && svc.name.toLowerCase() === bare)
      ) ?? null
    );
  }, [inCluster, services.data, pod.namespace]);

  /** The address is in another namespace, which this app did not list. */
  const elsewhere = useMemo(() => {
    if (!inCluster) return null;
    const { namespace } = namespaceOf(
      inCluster.host.toLowerCase(),
      pod.namespace
    );
    return namespace === pod.namespace ? null : namespace;
  }, [inCluster, pod.namespace]);

  const endpoints = useQuery({
    queryKey: [context, "hints", "endpoints", pod.namespace, service?.name],
    queryFn: () => commands.getEndpoints(service!.name, pod.namespace),
    enabled: service !== null,
    staleTime: STALE,
    retry: false,
  });

  const chain = useMemo<Chain>(() => {
    const notRead: string[] = [];
    if (logs.error && logContainer)
      notRead.push(
        t("hints", "notReadLogs", {
          container: logContainer,
          reason: logs.error.message,
        })
      );
    if (services.error)
      notRead.push(
        t("hints", "notReadService", {
          namespace: pod.namespace,
          reason: normalizeTauriError(services.error),
        })
      );
    if (endpoints.error && service)
      notRead.push(
        t("hints", "notReadEndpoints", {
          service: service.name,
          reason: normalizeTauriError(endpoints.error),
        })
      );
    if (address?.where === "outside")
      notRead.push(t("hints", "notReadPolicies"));
    if (elsewhere)
      notRead.push(
        t("hints", "notReadOtherNamespace", { namespace: elsewhere })
      );
    const ready =
      endpoints.data?.subsets.reduce((sum, s) => sum + s.addresses.length, 0) ??
      null;
    const notReady =
      endpoints.data?.subsets.reduce(
        (sum, s) => sum + s.notReadyAddresses.length,
        0
      ) ?? null;
    // The container that declares the port, not the next one in the list.
    // Declaration order named an unrelated container as the thing that is
    // not listening, and the pod's own `ports` answered the question.
    const sidecar =
      address?.where === "sidecar" && address.port !== null
        ? ([...pod.containers, ...pod.initContainers].find((c) =>
            c.ports.some((port) => port.containerPort === address.port)
          ) ?? null)
        : null;
    return {
      address,
      // A read that failed is not an answer. Without these, a 403 on the
      // Services of this namespace produced the same sentence as a cluster
      // where nothing answers to that address.
      // A Service in another namespace was never asked about, so nothing
      // here may say whether one answers to that address.
      servicesKnown:
        inCluster === null || (services.data !== undefined && !elsewhere),
      endpointsKnown: service === null || endpoints.data !== undefined,
      service: service
        ? {
            name: service.name,
            namespace: pod.namespace,
            // Found, but the endpoints behind it were not read: the count
            // is unknown rather than zero.
            ready: ready,
            total:
              ready !== null && notReady !== null ? ready + notReady : null,
          }
        : null,
      sidecar,
      notRead,
    };
  }, [
    address,
    service,
    endpoints.data,
    endpoints.error,
    elsewhere,
    inCluster,
    services.data,
    services.error,
    logs.error,
    logContainer,
    pod,
    t,
  ]);

  return { chain, logLines: logs.data ?? [], logContainer, previous };
}

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
  const { chain, logLines, logContainer, previous } = useChain(
    pod,
    trouble,
    settings.showPanel
  );
  const version = useQuery({
    queryKey: ["app-info"],
    queryFn: () => commands.getAppInfo(),
    staleTime: Infinity,
  });

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
