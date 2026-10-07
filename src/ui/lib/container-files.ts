import type {
  FileEntry,
  PodVolumeInfo,
  VolumeProjectionInfo,
} from "@/generated/types";

export type { FileEntry, FileKind, ListedWith } from "@/generated/types";

/** The mount a path sits in, for the tag beside the row. */
export interface MountTag {
  /** `ConfigMap`, `Secret`, … the volume's source word, or a projected source's (`serviceAccountToken`). */
  kind: string;
  /** The object's name, or the volume's; `null` for a projected source that names no object. */
  name: string | null;
  /** The volume the path is in. */
  volume: string;
  /** The mount point the path is under. */
  at: string;
  /**
   * Every source the tag may stand for: one where the spec says which wrote
   * the file, all of a `projected` volume's where it does not (its `..data`
   * link and the directory behind it hold every source's files).
   */
  sources: ReadonlyArray<{ kind: string; name: string }>;
}

function under(path: string, mount: string): boolean {
  const base = mount.endsWith("/") ? mount.slice(0, -1) : mount;
  return path === base || path.startsWith(`${base}/`);
}

/**
 * The projected source that wrote `relative`, where the spec says. The
 * kubelet writes the files into a timestamped directory behind a `..data`
 * link and links each at the top, so a path inside either is the file's own
 * path one level down. A source with no `items` writes a file per key it
 * holds: the file is its when no source names it and it is the only one.
 */
function writerOf(
  projections: readonly VolumeProjectionInfo[],
  relative: string
): VolumeProjectionInfo | null {
  const inner = relative.startsWith("..")
    ? relative.split("/").slice(1).join("/")
    : relative;
  if (inner === "") return null;
  const named = projections.filter((projection) =>
    projection.paths.some(
      (path) =>
        path === inner ||
        inner.startsWith(`${path}/`) ||
        path.startsWith(`${inner}/`)
    )
  );
  if (named.length > 0) return named.length === 1 ? named[0] : null;
  const everyKey = projections.filter(
    (projection) => projection.paths.length === 0
  );
  return everyKey.length === 1 ? everyKey[0] : null;
}

const sourceOf = (projection: VolumeProjectionInfo) => ({
  kind: projection.object?.kind ?? projection.source,
  name: projection.object?.name ?? "",
});

function tagOf(volume: PodVolumeInfo, at: string, path: string): MountTag {
  const base = at.endsWith("/") ? at.slice(0, -1) : at;
  const writer = writerOf(volume.projections, path.slice(base.length + 1));
  if (writer) {
    return {
      ...sourceOf(writer),
      name: writer.object?.name ?? null,
      volume: volume.name,
      at,
      sources: [sourceOf(writer)],
    };
  }
  const sources =
    volume.projections.length > 0
      ? volume.projections.map(sourceOf)
      : volume.refs.map((r) => ({ kind: r.kind, name: r.name }));
  const only = sources.length === 1 ? sources[0] : null;
  return {
    // With one source the tag can name it. With several, what is certain
    // is the volume.
    kind: only?.kind ?? volume.source,
    name: only ? only.name || null : volume.name,
    volume: volume.name,
    at,
    sources,
  };
}

/**
 * Which of this container's mounts a path is under: the deepest one, so a
 * file in a subPath mount inside a bigger volume is tagged with the inner.
 * Every fact here is already on the pod; the listing adds nothing.
 */
export function mountFor(
  path: string,
  container: string,
  volumes: readonly PodVolumeInfo[]
): MountTag | null {
  let best: { depth: number; volume: PodVolumeInfo; at: string } | null = null;
  for (const volume of volumes) {
    for (const mount of volume.mounts) {
      if (mount.container !== container || !under(path, mount.path)) continue;
      const depth = mount.path.split("/").filter(Boolean).length;
      if (best !== null && depth <= best.depth) continue;
      best = { depth, volume, at: mount.path };
    }
  }
  return best && tagOf(best.volume, best.at, path);
}

/**
 * Where the browser opens for a container: its first mount, because that
 * is what the reader came to look at. A mount with a `subPath` is often a
 * single file (a ConfigMap key over `/etc/app/app.conf`), and a file cannot
 * be listed; the mount's parent can, and shows the file as a row.
 */
export function startPath(
  volumes: readonly PodVolumeInfo[],
  container: string
): string {
  const mount = volumes
    .flatMap((volume) => volume.mounts)
    .find((m) => m.container === container);
  if (!mount) return "/";
  return mount.subPath ? parentOf(mount.path) : mount.path;
}

export function joinPath(dir: string, name: string): string {
  return dir === "/" ? `/${name}` : `${dir}/${name}`;
}

export function parentOf(path: string): string {
  if (path === "/") return "/";
  const cut = path.lastIndexOf("/");
  return cut <= 0 ? "/" : path.slice(0, cut);
}

/** `/etc/app/conf.d` → `["/", "/etc", "/etc/app", "/etc/app/conf.d"]`. */
export function crumbs(path: string): Array<{ name: string; path: string }> {
  const out = [{ name: "/", path: "/" }];
  let sofar = "";
  for (const part of path.split("/").filter(Boolean)) {
    sofar += `/${part}`;
    out.push({ name: part, path: sofar });
  }
  return out;
}

export type SortKey = "name" | "size" | "modified";

/** Directories first, then by the chosen key; a name sort is case-blind. */
export function sortEntries(
  entries: readonly FileEntry[],
  key: SortKey,
  descending: boolean
): FileEntry[] {
  const dirsFirst = (a: FileEntry, b: FileEntry) =>
    Number(b.kind === "dir") - Number(a.kind === "dir");
  const by = (a: FileEntry, b: FileEntry): number => {
    switch (key) {
      case "name":
        return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
      case "size":
        return a.size - b.size;
      case "modified":
        return (a.modified ?? 0) - (b.modified ?? 0);
    }
  };
  return [...entries].sort(
    (a, b) => dirsFirst(a, b) || (descending ? -by(a, b) : by(a, b))
  );
}

/** `755` → `rwxr-xr-x`, with the kind letter in front like `ls` writes it. */
export function modeText(entry: FileEntry): string {
  const bits = parseInt(entry.mode.slice(-3), 8);
  if (Number.isNaN(bits)) return entry.mode;
  const triplet = (n: number) =>
    `${n & 4 ? "r" : "-"}${n & 2 ? "w" : "-"}${n & 1 ? "x" : "-"}`;
  const lead =
    entry.kind === "dir"
      ? "d"
      : entry.kind === "symlink"
        ? "l"
        : entry.kind === "other"
          ? "?"
          : "-";
  return `${lead}${triplet(bits >> 6)}${triplet((bits >> 3) & 7)}${triplet(bits & 7)}`;
}

/** The filter is a plain substring, case-blind: a name, not a query. */
export function matches(entry: FileEntry, filter: string): boolean {
  const needle = filter.trim().toLowerCase();
  return needle === "" || entry.name.toLowerCase().includes(needle);
}

/**
 * The caps both halves of the boundary apply, as `src/contracts/file-limits.json`
 * states them; a test on each side holds them equal. They were spelled three
 * times — a literal here, `DOWNLOAD_MAX_BYTES` in Rust and a number baked
 * into the catalogue copy — which is exactly the drift the shared-constant
 * rule exists to stop.
 */
export const DOWNLOAD_MAX_BYTES = 2_147_483_648;
/** Past this a download is asked about first: minutes over exec, not a click. */
export const DOWNLOAD_CONFIRM_BYTES = 104_857_600;
export const PREVIEW_MAX_BYTES = 524_288;
export const MAX_ENTRIES = 20_000;
