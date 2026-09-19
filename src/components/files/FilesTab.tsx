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

import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { useToast } from "@/components/ui/use-toast";
import { useCopyToClipboard } from "@/hooks/useCopyToClipboard";
import { useNow, useNowTenths } from "@/hooks/useNow";
import { commands } from "@/lib/commands";
import {
  DOWNLOAD_CONFIRM_BYTES,
  DOWNLOAD_MAX_BYTES,
  PREVIEW_MAX_BYTES,
  crumbs,
  joinPath,
  matches,
  modeText,
  mountFor,
  startPath,
  parentOf,
  sortEntries,
  type FileEntry,
  type SortKey,
} from "@/lib/container-files";
import { normalizeTauriError } from "@/lib/error-utils";
import { formatBytes } from "@/lib/k8s-quantity";
import { formatShortcut } from "@/lib/platform";
import { useSurfaceVisible } from "@/lib/surface-visibility";
import { cn, formatSince } from "@/lib/utils";
import type { PodInfo, Via } from "@/generated/types";
import { offeredContainers } from "@/lib/container-sequence";
import { useT } from "@/i18n/useT";
import { useContainerFiles, type ListingState } from "./useContainerFiles";

const ROW_PX = 26;

/**
 * The key of the ".." row. A NUL, because that and `/` are the only bytes a
 * filename cannot hold — a plain `"up"` collided with a directory that had a
 * file called `up` in it, and React drew one of the two rows.
 */
const UP_ROW_KEY = "\u0000up";

/** One array, so an idle tab's memo is not invalidated by a fresh `[]`. */
const NO_ENTRIES: FileEntry[] = [];

export interface FilesTabProps {
  pod: PodInfo;
  /** Reading through a debug container the page started for this tab. */
  via: Via | null;
  onDebug: (container: string) => void;
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
  // offeredContainers, not pod.containers: every other pod surface counts
  // the init containers too, and a sidecar that only exists as an
  // initContainer was simply missing from the strip here — but *run* order
  // then put the mesh proxy first, and the tab opened on it rather than on
  // the container the reader came to look at. The Shell tab asks the same
  // question and gets the same order.
  const containers = offeredContainers(pod);
  const [containerName, setContainerName] = useState(
    () =>
      containers.find((c) => c.state.type === "running")?.name ??
      containers[0]?.name ??
      ""
  );
  const container = containers.find((c) => c.name === containerName) ?? null;
  const [path, setPath] = useState<string>(() =>
    startPath(pod.volumes, containerName)
  );
  const [sort, setSort] = useState<{ key: SortKey; descending: boolean }>({
    key: "name",
    descending: false,
  });
  const [filter, setFilter] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [mountsOnly, setMountsOnly] = useState(false);

  // The life a listing was taken from. A restart makes the current life a
  // different container; the old rows stay, with a banner, until asked.
  const currentLife = `${pod.uid}:${containerName}:${container?.restartCount ?? 0}`;
  const [life, setLife] = useState(currentLife);
  // Keying `life` by container name was half the fix. The other half is
  // that a `life` belonging to a *different* container is not a restart of
  // this one — it is a stale value from before the reader used the strip,
  // and comparing it fired "app has restarted since this listing" about a
  // container that had not restarted at all. Held rather than warned about.
  const sameContainer = life.startsWith(`${pod.uid}:${containerName}:`);
  const readingLife = sameContainer ? life : currentLife;
  const restartedSinceRead = sameContainer && life !== currentLife;
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
            life: readingLife,
          }
        : null,
    [
      container,
      running,
      mountsOnly,
      pod.name,
      pod.namespace,
      path,
      via,
      readingLife,
    ]
  );
  const { state, stop, reload } = useContainerFiles(target);

  // Two stages, and in this order. Sorting the filtered list meant every
  // keystroke re-sorted up to MAX_ENTRIES rows, and every 100 ms batch
  // re-filtered them; and the memo watched the whole `state`, so a phase
  // change with the same rows did the work again. Filtering preserves order,
  // so a keystroke is now a walk and no sort at all.
  const entries = state.phase === "idle" ? NO_ENTRIES : state.entries;
  const sorted = useMemo(
    () => sortEntries(entries, sort.key, sort.descending),
    [entries, sort]
  );
  const rows = useMemo(
    () => (filter ? sorted.filter((e) => matches(e, filter)) : sorted),
    [sorted, filter]
  );

  // The preview execs into the container, and every selection is one exec.
  // Holding ArrowDown down a directory opened one session per keypress, all
  // but the last of them for a row nobody looked at.
  const previewed = useDebounced(selected, 200);
  const previewEntry =
    previewed === null
      ? null
      : (rows.find((r) => r.name === previewed) ?? null);

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
  const selectedEntry = rows.find((r) => r.name === selected) ?? null;
  const [bigDownload, setBigDownload] = useState(false);
  const download = useCallback(
    async (confirmed = false) => {
      if (!selectedEntry || !container) return;
      // The button is disabled past the cap; ⌘S reached the same command with
      // nothing in its way, and the reader got a refusal from the backend
      // instead of the sentence the button's tooltip had been showing.
      if (selectedEntry.size > DOWNLOAD_MAX_BYTES) {
        toast({
          title: t("files", "downloadFailed", { name: selectedEntry.name }),
          description: t("files", "tooBigToDownload", {
            cap: formatBytes(DOWNLOAD_MAX_BYTES, 0),
          }),
          variant: "destructive",
        });
        return;
      }
      if (selectedEntry.size > DOWNLOAD_CONFIRM_BYTES && !confirmed) {
        setBigDownload(true);
        return;
      }
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
        if (result.state === "noTools" || result.state === "failed") {
          toast({
            title: t("files", "downloadFailed", { name: selectedEntry.name }),
            description:
              result.state === "noTools"
                ? t("files", "noCatInImage")
                : result.message,
            variant: "destructive",
          });
        } else {
          toast({
            title: t("files", "downloaded", { name: selectedEntry.name }),
            description:
              result.state === "written"
                ? `${destination} · ${formatBytes(result.bytes, 1)}`
                : destination,
          });
        }
      } catch (error) {
        toast({
          title: t("files", "downloadFailed", { name: selectedEntry.name }),
          description: normalizeTauriError(error),
          variant: "destructive",
        });
      }
    },
    [selectedEntry, container, pod.name, pod.namespace, path, via, toast, t]
  );

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
      <ConfirmDialog
        open={bigDownload}
        onOpenChange={setBigDownload}
        title={t("files", "bigDownloadTitle", {
          name: selectedEntry?.name ?? "",
          size: formatBytes(selectedEntry?.size ?? 0, 1),
        })}
        description={t("files", "bigDownloadBody")}
        confirmLabel={t("action", "download")}
        onConfirm={() => void download(true)}
      />
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
              // While a debug container is the way in, the bytes come from
              // its /proc/1/root — one specific container. Switching used to
              // change only the label, so the rows of one container were
              // shown under another's name.
              disabled={via !== null && c.name !== containerName}
              title={
                via !== null && c.name !== containerName
                  ? t("files", "cannotSwitchViaDebug")
                  : undefined
              }
              onClick={() => {
                setContainerName(c.name);
                setSelected(null);
                setMountsOnly(false);
              }}
              className={cn(
                "rounded px-1.5 py-0.5 font-mono",
                c.name === containerName
                  ? "bg-sel text-fg"
                  : via !== null
                    ? "cursor-not-allowed text-fg-fnt"
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
        <Status state={state} onStop={stop} />
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
      {restartedSinceRead && state.phase !== "idle" && (
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
          path={path}
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
              // "This directory is empty" is a claim about a read that
              // finished and saw everything. A read the reader cut short,
              // and a read whose every line the parser refused, are two
              // other answers — and neither is "there is nothing here".
              state.stopped ? (
                <Sentence>{t("files", "stoppedBeforeAnything")}</Sentence>
              ) : state.unreadable ? (
                <Sentence>
                  {t("files", "nothingReadable", { n: state.unreadable })}
                </Sentence>
              ) : (
                <Sentence>{t("files", "emptyDirectory", { path })}</Sentence>
              )
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
          {previewEntry && previewEntry.kind !== "dir" && (
            <Preview
              pod={pod}
              container={container.name}
              path={joinPath(path, previewEntry.name)}
              entry={previewEntry}
              life={readingLife}
              via={via}
              onDownload={() => void download()}
            />
          )}
        </div>
      )}
    </div>
  );
}

/**
 * `value`, once it has stopped changing for `ms`. Its own timer rather than
 * a shared clock: it is following a person's finger on the arrow keys, and
 * the point is the pause between presses.
 */
function useDebounced<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return settled;
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

function Reading({
  entries,
  startedAt,
  onStop,
}: {
  entries: number;
  startedAt: number;
  onStop: () => void;
}) {
  const t = useT();
  // Ten times a second, but only while somebody is looking: Radix
  // force-mounts a detail tab once it has been opened, so a Files tab
  // switched away from mid-read kept the whole subtree re-rendering at
  // nobody for as long as the page stayed open.
  const now = useNowTenths(useSurfaceVisible());
  // A listing whose start nobody recorded is timed by nobody: the sentence
  // without the seconds, rather than a confident "0.0 s".
  const seconds =
    startedAt === 0 ? null : (Math.max(0, now - startedAt) / 1000).toFixed(1);
  return (
    <span className="flex items-center gap-2 text-fg-fnt">
      {seconds === null
        ? t("files", "readingSoFarUntimed", { n: entries })
        : t("files", "readingSoFar", { n: entries, seconds })}
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

function Status({
  state,
  onStop,
}: {
  state: ListingState;
  onStop: () => void;
}) {
  const t = useT();
  if (state.phase === "idle") return null;
  if (state.phase === "reading") {
    return (
      <Reading
        entries={state.entries.length}
        startedAt={state.startedAt}
        onStop={onStop}
      />
    );
  }
  if (state.phase === "done") {
    return (
      <span className="text-fg-fnt">
        {/* Which rung answered and how long it took are two more things the
         *  reader can be told or not told. Cut short before the backend
         *  said, the sentence is the one without them. */}
        {state.with === null || state.elapsedMs === null
          ? t("files", "stoppedUntimed", { n: state.entries.length })
          : t("files", state.stopped ? "stoppedAfter" : "readVia", {
              how: t(
                "files",
                state.with === "gnuFind" ? "gnuFind" : "busyboxStat"
              ),
              n: state.entries.length,
              seconds: (state.elapsedMs / 1000).toFixed(1),
            })}
        {/* The count is what was seen, and says so when that is not the
         *  whole: cut off at the row cap, or with lines nobody could read. */}
        {state.partial && !state.stopped && (
          <span className="ml-1 text-warn">
            {t("files", "cappedAt", { n: state.entries.length })}
          </span>
        )}
        {state.unreadable !== null && state.unreadable > 0 && (
          <span className="ml-1 text-warn">
            {t("files", "unreadableLines", { n: state.unreadable })}
          </span>
        )}
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

  // Scroll to the selection when the *selection* moves. With `rows` in the
  // deps this re-fired on every streamed batch, so a reader scrolling
  // through a directory that was still arriving was yanked back to their
  // selected row ten times a second. `rows` is read, not watched.
  const latestRows = useRef(rows);
  latestRows.current = rows;
  useEffect(() => {
    const index = latestRows.current.findIndex((r) => r.name === selected);
    if (index >= 0) virtualizer.scrollToIndex(index + (canGoUp ? 1 : 0));
  }, [selected, canGoUp, virtualizer]);

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
                key={UP_ROW_KEY}
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
                    // Every source, because with more than one the badge
                    // deliberately names none of them.
                    title={`${tag.sources
                      .map((r) => `${r.kind} ${r.name}`)
                      .join(" · ")} ${tag.at}`.trim()}
                  >
                    {t("files", "fromMount", { name: tag.name })}
                  </span>
                )}
              </span>
              <span className="text-fg-fnt">{modeText(entry)}</span>
              <span className="text-right tabular-nums text-fg-mut">
                {entry.kind === "dir" ? "" : formatBytes(entry.size, 1)}
              </span>
              <span
                className="text-right tabular-nums text-fg-fnt"
                title={
                  entry.modified
                    ? new Date(entry.modified * 1000).toLocaleString()
                    : undefined
                }
              >
                {entry.modified ? formatSince(entry.modified * 1000, now) : ""}
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
  path,
  onDebug,
  onMounts,
  onRetry,
}: {
  state: Extract<ListingState, { phase: "failed" }>;
  container: string;
  image: string;
  path: string;
  onDebug: (container: string) => void;
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
          <button
            type="button"
            onClick={() => onDebug(container)}
            className={link}
          >
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
  // The path itself could not be opened. Retrying reads the same
  // permissions again; a debug container is the way in, so it is offered
  // here the way it is for an image with no tools.
  if (state.reason === "unopenable") {
    return (
      <div className="px-3 py-6 text-xs">
        <p className="font-medium text-err">
          {t("files", "unopenable", { path })}
        </p>
        <p className="mt-3 flex gap-4">
          <button
            type="button"
            onClick={() => onDebug(container)}
            className={link}
          >
            {t("files", "openViaDebug")}
          </button>
          <button type="button" onClick={onRetry} className={link}>
            {t("action", "retry")}
          </button>
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
  life,
  via,
  onDownload,
}: {
  pod: PodInfo;
  container: string;
  path: string;
  entry: FileEntry;
  /** The listing's `uid:container:restarts`, keyed on for the same reason. */
  life: string;
  via: Via | null;
  onDownload: () => void;
}) {
  const t = useT();
  const copy = useCopyToClipboard();
  const query = useQuery({
    queryKey: [
      "container-file",
      // The life, like the listing: a restart replaces the filesystem
      // outside the mounts, so a cached preview is of a container that no
      // longer exists.
      life,
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
  // Split once per answer, not once per render: the preview is up to
  // PREVIEW_MAX_BYTES of text and this sat in the component body.
  const lines = useMemo(
    () =>
      read?.state === "preview" && read.preview.text
        ? read.preview.text.split("\n").length
        : null,
    [read]
  );
  const tooBig = entry.size > DOWNLOAD_MAX_BYTES;

  return (
    <div className="flex w-[46%] min-w-0 flex-col border-l border-hair">
      <div className="border-b border-hair px-3 py-2 text-[11px]">
        <p className="truncate font-mono text-xs text-fg">{path}</p>
        <p className="mt-0.5 text-fg-fnt">
          {formatBytes(entry.size, 1)}
          {read?.state === "preview" &&
            ` · ${read.preview.binary ? t("files", "binary") : t("files", "text")}`}
          {/* Beside the file's whole size, a bare count reads as the file's
           *  line count — and the preview stopped at the cap, so it is the
           *  count of what was read and a floor on the rest. */}
          {lines !== null &&
            ` · ${
              read?.state === "preview" && read.preview.truncated
                ? t("files", "lineCountAtLeast", { n: lines })
                : t("files", "lineCount", { n: lines })
            }`}
          {tag &&
            ` · ${
              tag.sources.length > 1
                ? t("files", "mountedFromSeveral", {
                    name: tag.name,
                    n: tag.sources.length,
                  })
                : t("files", "mountedFrom", { kind: tag.kind, name: tag.name })
            }`}
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
            title={
              tooBig
                ? t("files", "tooBigToDownload", {
                    cap: formatBytes(DOWNLOAD_MAX_BYTES, 0),
                  })
                : undefined
            }
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
            {/* The bytes were not UTF-8 and what is below is our repair of
             *  them. Drawn above the text, because a reader who scrolls to
             *  the bottom for it has already read a file we changed. */}
            {read.preview.lossy && (
              <p className="mb-2 text-warn">{t("files", "previewRepaired")}</p>
            )}
            <pre className="whitespace-pre-wrap break-all text-fg-mid">
              {read.preview.text}
            </pre>
            {read.preview.truncated && (
              <p className="mt-2 text-fg-fnt">
                {t("files", "previewTruncated", {
                  cap: formatBytes(PREVIEW_MAX_BYTES, 0),
                })}
              </p>
            )}
          </>
        ) : null}
      </div>
    </div>
  );
}
