import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { useQuery } from "@tanstack/react-query";
import { useVirtualizer } from "@tanstack/react-virtual";
import { save } from "@tauri-apps/plugin-dialog";
import {
  ArrowUpDown,
  Download,
  File,
  FileSymlink,
  Folder,
  Square,
} from "lucide-react";

import { useToast } from "@/components/ui/use-toast";
import { useCopyToClipboard } from "@/hooks/useCopyToClipboard";
import { useNow } from "@/hooks/useNow";
import { commands } from "@/lib/commands";
import {
  crumbs,
  joinPath,
  matches,
  modeText,
  mountFor,
  parentOf,
  sortEntries,
  type FileEntry,
  type SortKey,
} from "@/lib/container-files";
import { normalizeTauriError } from "@/lib/error-utils";
import { formatBytes } from "@/lib/k8s-quantity";
import { formatShortcut } from "@/lib/platform";
import { agoOf } from "@/lib/usage-history";
import { cn } from "@/lib/utils";
import type { PodInfo, Via } from "@/generated/types";
import { useT } from "@/i18n/useT";
import { useContainerFiles, type ListingState } from "./useContainerFiles";

const ROW_PX = 26;

export interface FilesTabProps {
  pod: PodInfo;
  /** Reading through a debug container the page started for this tab. */
  via: Via | null;
  onDebug: () => void;
  onStopVia: () => void;
}

/**
 * The files of one container, read and never written.
 *
 * One list, not a tree: every level is one exec. The rows carry the mount
 * they come from, because the pod already says so. Every way the read can
 * end is a different sentence, and none of them is an empty list.
 */
export function FilesTab({ pod, via, onDebug, onStopVia }: FilesTabProps) {
  const t = useT();
  const containers = pod.containers;
  const [containerName, setContainerName] = useState(
    () =>
      containers.find((c) => c.state.type === "running")?.name ??
      containers[0]?.name ??
      ""
  );
  const container = containers.find((c) => c.name === containerName) ?? null;
  const firstMount = useMemo(
    () =>
      pod.volumes
        .flatMap((v) => v.mounts)
        .find((m) => m.container === containerName)?.path ?? null,
    [pod.volumes, containerName]
  );
  const [path, setPath] = useState<string>(() => firstMount ?? "/");
  const [sort, setSort] = useState<{ key: SortKey; descending: boolean }>({
    key: "name",
    descending: false,
  });
  const [filter, setFilter] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [mountsOnly, setMountsOnly] = useState(false);

  // The life a listing was taken from. A restart makes the current life a
  // different container; the old rows stay, with a banner, until asked.
  const currentLife = `${pod.uid}:${container?.restartCount ?? 0}`;
  const [life, setLife] = useState(currentLife);
  const running = via !== null || container?.state.type === "running";

  const target = useMemo(
    () =>
      container && running && !mountsOnly
        ? {
            pod: pod.name,
            namespace: pod.namespace,
            container: container.name,
            path,
            via,
            life,
          }
        : null,
    [container, running, mountsOnly, pod.name, pod.namespace, path, via, life]
  );
  const { state, stop, reload } = useContainerFiles(target);

  const rows = useMemo(() => {
    const entries = state.phase === "idle" ? [] : state.entries;
    return sortEntries(
      entries.filter((e) => matches(e, filter)),
      sort.key,
      sort.descending
    );
  }, [state, filter, sort]);

  const open = useCallback(
    (entry: FileEntry) => {
      if (entry.kind === "dir") {
        setPath(joinPath(path, entry.name));
        setSelected(null);
        setFilter("");
      } else {
        setSelected(entry.name);
      }
    },
    [path]
  );
  const up = useCallback(() => {
    setPath(parentOf(path));
    setSelected(null);
    setFilter("");
  }, [path]);

  const { toast } = useToast();
  const now = useNow();
  const selectedEntry = rows.find((r) => r.name === selected) ?? null;
  const download = useCallback(async () => {
    if (!selectedEntry || !container) return;
    const destination = await save({ defaultPath: selectedEntry.name });
    if (!destination) return;
    try {
      const result = await commands.downloadContainerFile(
        pod.name,
        pod.namespace,
        container.name,
        joinPath(path, selectedEntry.name),
        via,
        destination
      );
      if (result.state === "preview") {
        toast({
          title: t("files", "downloaded", { name: selectedEntry.name }),
          description: destination,
        });
      } else {
        toast({
          title: t("files", "downloadFailed", { name: selectedEntry.name }),
          description:
            result.state === "noTools"
              ? t("files", "noCatInImage")
              : result.message,
          variant: "destructive",
        });
      }
    } catch (error) {
      toast({
        title: t("files", "downloadFailed", { name: selectedEntry.name }),
        description: normalizeTauriError(error),
        variant: "destructive",
      });
    }
  }, [selectedEntry, container, pod.name, pod.namespace, path, via, toast, t]);

  const onKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const index = rows.findIndex((r) => r.name === selected);
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setSelected(rows[Math.min(rows.length - 1, index + 1)]?.name ?? null);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setSelected(rows[Math.max(0, index - 1)]?.name ?? null);
    } else if (event.key === "Enter" && selectedEntry) {
      event.preventDefault();
      open(selectedEntry);
    } else if (event.key === "Backspace" && filter === "") {
      event.preventDefault();
      up();
    } else if (
      (event.metaKey || event.ctrlKey) &&
      event.key.toLowerCase() === "s"
    ) {
      event.preventDefault();
      void download();
    }
  };

  if (!container) {
    return (
      <p className="p-3 text-xs text-fg-mut">{t("files", "noContainers")}</p>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-hair px-3 py-2 text-[11px]">
        <span
          className="flex items-center gap-0.5"
          role="tablist"
          aria-label={t("columns", "containers")}
        >
          {containers.map((c) => (
            <button
              key={c.name}
              type="button"
              role="tab"
              aria-selected={c.name === containerName}
              onClick={() => {
                setContainerName(c.name);
                setSelected(null);
                setMountsOnly(false);
              }}
              className={cn(
                "rounded px-1.5 py-0.5 font-mono",
                c.name === containerName
                  ? "bg-sel text-fg"
                  : "text-fg-mut hover:bg-hover hover:text-fg"
              )}
            >
              {c.name}
              {c.state.type !== "running" && (
                <span className="ml-1 text-fg-fnt">· {c.state.type}</span>
              )}
            </button>
          ))}
        </span>
        <Status state={state} onStop={stop} now={now} />
      </div>

      {via && (
        <Notice tone="warn">
          {t("files", "viaDebug", {
            debug: via.container,
            root: via.root,
            container: container.name,
          })}{" "}
          <button
            type="button"
            onClick={onStopVia}
            className="text-info hover:underline"
          >
            {t("files", "stopVia")}
          </button>
        </Notice>
      )}
      {life !== currentLife && state.phase !== "idle" && (
        <Notice tone="warn">
          {t("files", "restartedSince", {
            container: container.name,
            restarts: container.restartCount,
          })}{" "}
          <button
            type="button"
            onClick={() => setLife(currentLife)}
            className="text-info hover:underline"
          >
            {t("files", "readNewContainer")}
          </button>
        </Notice>
      )}

      <div className="flex items-center gap-1 border-b border-hair px-3 py-1.5 font-mono text-[11px]">
        {crumbs(path).map((crumb, i) => (
          <span key={crumb.path} className="flex items-center gap-1">
            {i > 0 && <span className="text-fg-fnt">/</span>}
            <button
              type="button"
              onClick={() => {
                setPath(crumb.path);
                setSelected(null);
              }}
              className={cn(
                "rounded px-1 hover:bg-hover",
                crumb.path === path ? "text-fg" : "text-fg-mut"
              )}
            >
              {crumb.name === "/" ? "/" : crumb.name}
            </button>
          </span>
        ))}
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder={t("files", "filterNames", {
            n: state.phase === "idle" ? 0 : state.entries.length,
          })}
          className="ml-auto w-48 rounded border border-hair bg-canvas px-1.5 py-0.5 text-[11px] focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-info"
        />
      </div>

      {!running && !mountsOnly ? (
        <Sentence>
          {t("files", "notRunning", {
            container: container.name,
            state: container.state.type,
          })}
        </Sentence>
      ) : mountsOnly ? (
        <MountsOnly
          pod={pod}
          container={container.name}
          onBack={() => setMountsOnly(false)}
        />
      ) : state.phase === "failed" ? (
        <Failure
          state={state}
          container={container.name}
          image={container.image}
          onDebug={onDebug}
          onMounts={() => setMountsOnly(true)}
          onRetry={reload}
        />
      ) : (
        <div className="flex min-h-0 flex-1">
          <div
            className="flex min-h-0 flex-1 flex-col outline-none"
            tabIndex={0}
            onKeyDown={onKey}
            role="grid"
            aria-label={t("files", "listingOf", { path })}
          >
            <div className="grid grid-cols-[minmax(0,1fr)_100px_80px_90px] gap-x-3 border-b border-hair px-3 py-1 text-[11px] text-fg-fnt">
              <SortHead
                k="name"
                sort={sort}
                onSort={setSort}
                label={t("columns", "name")}
              />
              <span>{t("files", "mode")}</span>
              <SortHead
                k="size"
                sort={sort}
                onSort={setSort}
                label={t("files", "size")}
                right
              />
              <SortHead
                k="modified"
                sort={sort}
                onSort={setSort}
                label={t("files", "modified")}
                right
              />
            </div>
            {state.phase === "done" && state.entries.length === 0 ? (
              <Sentence>{t("files", "emptyDirectory", { path })}</Sentence>
            ) : (
              <Rows
                rows={rows}
                path={path}
                pod={pod}
                container={container.name}
                selected={selected}
                onSelect={setSelected}
                onOpen={open}
                canGoUp={path !== "/"}
                onUp={up}
              />
            )}
            <p className="border-t border-hair px-3 py-1 text-[10px] text-fg-fnt">
              {t("files", "keys", { download: formatShortcut("mod+s") })}
            </p>
          </div>
          {selectedEntry && selectedEntry.kind !== "dir" && (
            <Preview
              pod={pod}
              container={container.name}
              path={joinPath(path, selectedEntry.name)}
              entry={selectedEntry}
              via={via}
              onDownload={download}
            />
          )}
        </div>
      )}
    </div>
  );
}

function Sentence({ children }: { children: React.ReactNode }) {
  return <p className="px-3 py-6 text-xs text-fg-mut">{children}</p>;
}

function Notice({
  tone,
  children,
}: {
  tone: "warn" | "err";
  children: React.ReactNode;
}) {
  return (
    <p
      role="status"
      className={cn(
        "border-b border-hair px-3 py-1.5 text-[11px]",
        tone === "warn" ? "text-warn" : "text-err"
      )}
    >
      {children}
    </p>
  );
}

function Status({
  state,
  onStop,
  now,
}: {
  state: ListingState;
  onStop: () => void;
  now: number;
}) {
  const t = useT();
  if (state.phase === "idle") return null;
  if (state.phase === "reading") {
    return (
      <span className="flex items-center gap-2 text-fg-fnt">
        {t("files", "readingSoFar", {
          n: state.entries.length,
          seconds:
            state.startedAt === 0
              ? "0.0"
              : (Math.max(0, now - state.startedAt) / 1000).toFixed(1),
        })}
        <button
          type="button"
          onClick={onStop}
          className="flex items-center gap-1 rounded px-1.5 py-0.5 text-fg-mut hover:bg-hover hover:text-fg"
        >
          <Square className="h-3 w-3" />
          {t("action", "stop")}
        </button>
      </span>
    );
  }
  if (state.phase === "done") {
    return (
      <span className="text-fg-fnt">
        {t("files", state.stopped ? "stoppedAfter" : "readVia", {
          how: t("files", state.with === "gnuFind" ? "gnuFind" : "busyboxStat"),
          n: state.entries.length,
          seconds: (state.elapsedMs / 1000).toFixed(1),
        })}
      </span>
    );
  }
  return null;
}

function SortHead({
  k,
  sort,
  onSort,
  label,
  right = false,
}: {
  k: SortKey;
  sort: { key: SortKey; descending: boolean };
  onSort: (next: { key: SortKey; descending: boolean }) => void;
  label: string;
  right?: boolean;
}) {
  const active = sort.key === k;
  return (
    <button
      type="button"
      onClick={() =>
        onSort({ key: k, descending: active ? !sort.descending : k !== "name" })
      }
      className={cn(
        "flex items-center gap-1 hover:text-fg",
        right && "justify-end",
        active && "text-fg"
      )}
    >
      {label}
      {active && <ArrowUpDown className="h-3 w-3" />}
    </button>
  );
}

function Rows({
  rows,
  path,
  pod,
  container,
  selected,
  onSelect,
  onOpen,
  canGoUp,
  onUp,
}: {
  rows: FileEntry[];
  path: string;
  pod: PodInfo;
  container: string;
  selected: string | null;
  onSelect: (name: string) => void;
  onOpen: (entry: FileEntry) => void;
  canGoUp: boolean;
  onUp: () => void;
}) {
  const t = useT();
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const count = rows.length + (canGoUp ? 1 : 0);
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_PX,
    overscan: 20,
    // A size before the first measurement: without one a test's jsdom, which
    // measures every box as zero, draws no rows at all.
    initialRect: { width: 800, height: 600 },
  });
  const now = useNow();

  useEffect(() => {
    const index = rows.findIndex((r) => r.name === selected);
    if (index >= 0) virtualizer.scrollToIndex(index + (canGoUp ? 1 : 0));
  }, [selected, rows, canGoUp, virtualizer]);

  return (
    <div
      ref={scrollRef}
      className="min-h-0 flex-1 overflow-auto scrollbar-thin"
    >
      <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
        {virtualizer.getVirtualItems().map((item) => {
          const style = {
            position: "absolute" as const,
            top: 0,
            left: 0,
            width: "100%",
            height: ROW_PX,
            transform: `translateY(${item.start}px)`,
          };
          if (canGoUp && item.index === 0) {
            return (
              <button
                key="up"
                type="button"
                style={style}
                onDoubleClick={onUp}
                onClick={onUp}
                className="grid grid-cols-[minmax(0,1fr)_100px_80px_90px] items-center gap-x-3 px-3 text-left font-mono text-xs text-fg-mut hover:bg-hover"
              >
                <span className="flex items-center gap-2">
                  <Folder className="h-3.5 w-3.5 text-fg-fnt" />
                  ..
                </span>
              </button>
            );
          }
          const entry = rows[item.index - (canGoUp ? 1 : 0)];
          const tag = mountFor(
            joinPath(path, entry.name),
            container,
            pod.volumes
          );
          const Icon =
            entry.kind === "dir"
              ? Folder
              : entry.kind === "symlink"
                ? FileSymlink
                : File;
          return (
            <div
              key={entry.name}
              role="row"
              aria-selected={entry.name === selected}
              style={style}
              onClick={() => onSelect(entry.name)}
              onDoubleClick={() => onOpen(entry)}
              className={cn(
                "grid cursor-default grid-cols-[minmax(0,1fr)_100px_80px_90px] items-center gap-x-3 px-3 font-mono text-xs",
                entry.name === selected ? "bg-sel text-fg" : "hover:bg-hover"
              )}
            >
              <span className="flex min-w-0 items-center gap-2">
                <Icon className="h-3.5 w-3.5 flex-none text-fg-fnt" />
                <span className="truncate">{entry.name}</span>
                {entry.target && (
                  <span className="truncate text-fg-fnt">→ {entry.target}</span>
                )}
                {tag && (
                  <span
                    className="ml-1 truncate rounded border border-hair px-1 text-[10px] text-fg-mut"
                    title={`${tag.kind} ${tag.name} · ${tag.at}`}
                  >
                    {t("files", "fromMount", { name: tag.name })}
                  </span>
                )}
              </span>
              <span className="text-fg-fnt">{modeText(entry)}</span>
              <span className="text-right tabular-nums text-fg-mut">
                {entry.kind === "dir" ? "" : formatBytes(entry.size, 1)}
              </span>
              <span className="text-right tabular-nums text-fg-fnt">
                {entry.modified ? agoOf(entry.modified * 1000, now) : ""}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Failure({
  state,
  container,
  image,
  onDebug,
  onMounts,
  onRetry,
}: {
  state: Extract<ListingState, { phase: "failed" }>;
  container: string;
  image: string;
  onDebug: () => void;
  onMounts: () => void;
  onRetry: () => void;
}) {
  const t = useT();
  const link = "text-info hover:underline";
  if (state.reason === "noTools") {
    return (
      <div className="px-3 py-6 text-xs">
        <p className="font-medium text-fg">{t("files", "noToolsTitle")}</p>
        <p className="mt-1 text-fg-mut">
          {t("files", "noToolsBody", {
            tried: state.tried.join(", "),
            container,
            image,
          })}
        </p>
        <p className="mt-3 flex gap-4">
          <button type="button" onClick={onDebug} className={link}>
            {t("files", "openViaDebug")}
          </button>
          <button type="button" onClick={onMounts} className={link}>
            {t("files", "readMountsInstead")}
          </button>
        </p>
        <p className="mt-2 text-[11px] text-fg-fnt">
          {t("files", "debugExplained")}
        </p>
      </div>
    );
  }
  const title =
    state.reason === "refused"
      ? t("files", "refused")
      : state.reason === "notRunning"
        ? t("files", "notRunningNow", { container })
        : t("files", "listFailed", { code: state.exitCode ?? "?" });
  return (
    <div className="px-3 py-6 text-xs">
      <p className="font-medium text-err">{title}</p>
      <pre className="mt-1 whitespace-pre-wrap font-mono text-[11px] text-fg-mut">
        {state.stderr.trim() || state.message}
      </pre>
      <button type="button" onClick={onRetry} className={cn("mt-3", link)}>
        {t("action", "retry")}
      </button>
    </div>
  );
}

function MountsOnly({
  pod,
  container,
  onBack,
}: {
  pod: PodInfo;
  container: string;
  onBack: () => void;
}) {
  const t = useT();
  const mounts = pod.volumes.flatMap((volume) =>
    volume.mounts
      .filter((m) => m.container === container)
      .map((m) => ({ volume, mount: m }))
  );
  return (
    <div className="px-3 py-4 text-xs">
      <p className="text-fg-mut">
        {t("files", "mountsOnlyIntro", { container })}
      </p>
      <ul className="mt-2 space-y-1 font-mono">
        {mounts.map(({ volume, mount }) => (
          <li key={`${volume.name}:${mount.path}`}>
            {mount.path}
            <span className="ml-2 text-fg-fnt">
              {volume.refs[0]
                ? `${volume.refs[0].kind} ${volume.refs[0].name}`
                : volume.source}
              {mount.readOnly ? " · ro" : ""}
            </span>
          </li>
        ))}
        {mounts.length === 0 && (
          <li className="text-fg-fnt">{t("files", "noMounts")}</li>
        )}
      </ul>
      <button
        type="button"
        onClick={onBack}
        className="mt-3 text-info hover:underline"
      >
        {t("action", "back")}
      </button>
    </div>
  );
}

function Preview({
  pod,
  container,
  path,
  entry,
  via,
  onDownload,
}: {
  pod: PodInfo;
  container: string;
  path: string;
  entry: FileEntry;
  via: Via | null;
  onDownload: () => void;
}) {
  const t = useT();
  const copy = useCopyToClipboard();
  const query = useQuery({
    queryKey: [
      "container-file",
      pod.uid,
      container,
      path,
      via?.container ?? "",
    ],
    queryFn: () =>
      commands.readContainerFile(pod.name, pod.namespace, container, path, via),
    staleTime: 10_000,
    retry: false,
  });
  const tag = mountFor(path, container, pod.volumes);
  const read = query.data;
  const lines =
    read?.state === "preview" && read.preview.text
      ? read.preview.text.split("\n").length
      : null;
  const tooBig = entry.size > 100 * 1024 * 1024;

  return (
    <div className="flex w-[46%] min-w-0 flex-col border-l border-hair">
      <div className="border-b border-hair px-3 py-2 text-[11px]">
        <p className="truncate font-mono text-xs text-fg">{path}</p>
        <p className="mt-0.5 text-fg-fnt">
          {formatBytes(entry.size, 1)}
          {read?.state === "preview" &&
            ` · ${read.preview.binary ? t("files", "binary") : t("files", "text")}`}
          {lines !== null && ` · ${t("files", "lineCount", { n: lines })}`}
          {tag &&
            ` · ${t("files", "mountedFrom", { kind: tag.kind, name: tag.name })}`}
        </p>
        <p className="mt-1 flex gap-3">
          <button
            type="button"
            onClick={() => copy(path, t("files", "pathCopied"))}
            className="text-info hover:underline"
          >
            {t("files", "copyPath")}
          </button>
          <button
            type="button"
            onClick={onDownload}
            disabled={tooBig}
            className="flex items-center gap-1 text-info hover:underline disabled:cursor-not-allowed disabled:opacity-50"
            title={tooBig ? t("files", "tooBigToDownload") : undefined}
          >
            <Download className="h-3 w-3" />
            {t("action", "download")}
          </button>
        </p>
      </div>
      <div className="min-h-0 flex-1 overflow-auto scrollbar-thin px-3 py-2 font-mono text-[11px]">
        {query.isPending ? (
          <span className="text-fg-fnt">{t("action", "readingInline")}</span>
        ) : query.error ? (
          <span className="text-err">{normalizeTauriError(query.error)}</span>
        ) : read?.state === "noTools" ? (
          <span className="text-fg-mut">{t("files", "noHeadInImage")}</span>
        ) : read?.state === "failed" ? (
          <span className="text-err">
            {t("files", "readFailed", { code: read.exit_code ?? "?" })}{" "}
            {read.message}
          </span>
        ) : read?.state === "preview" && read.preview.binary ? (
          <div className="text-fg-mut">
            <p>{t("files", "noPreviewBinary")}</p>
            <p className="mt-1 text-fg-fnt">
              {t("files", "nonTextShare", {
                percent: Math.round(read.preview.nonTextShare * 100),
              })}
            </p>
          </div>
        ) : read?.state === "preview" ? (
          <>
            <pre className="whitespace-pre-wrap break-all text-fg-mid">
              {read.preview.text}
            </pre>
            {read.preview.truncated && (
              <p className="mt-2 text-fg-fnt">
                {t("files", "previewTruncated")}
              </p>
            )}
          </>
        ) : null}
      </div>
    </div>
  );
}
