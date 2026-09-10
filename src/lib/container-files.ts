import type { PodVolumeInfo } from "@/generated/types";

/**
 * The event payloads, mirrored by hand: the bindings generator only emits
 * what a command signature reaches, and these ride events.
 */
export type FileKind = "file" | "dir" | "symlink" | "other";

export interface FileEntry {
  name: string;
  kind: FileKind;
  /** Octal, as the tool printed it: `644`, `755`. */
  mode: string;
  size: number;
  /** Seconds since the epoch; `null` when the tool gave none. */
  modified: number | null;
  owner: string;
  group: string;
  /** Where a symlink points, as written. */
  target: string | null;
}

/** Which rung of the ladder answered. */
export type ListedWith = "gnuFind" | "busyboxStat";

/** The mount a path sits in, for the tag beside the row. */
export interface MountTag {
  /** `ConfigMap`, `Secret`, `PersistentVolumeClaim`, … or the volume's source word. */
  kind: string;
  name: string;
  /** The mount point the path is under. */
  at: string;
}

function under(path: string, mount: string): boolean {
  const base = mount.endsWith("/") ? mount.slice(0, -1) : mount;
  return path === base || path.startsWith(`${base}/`);
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
  let best: { depth: number; tag: MountTag } | null = null;
  for (const volume of volumes) {
    for (const mount of volume.mounts) {
      if (mount.container !== container || !under(path, mount.path)) continue;
      const depth = mount.path.split("/").filter(Boolean).length;
      if (best !== null && depth <= best.depth) continue;
      const ref = volume.refs[0];
      best = {
        depth,
        tag: {
          kind: ref?.kind ?? volume.source,
          name: ref?.name ?? volume.name,
          at: mount.path,
        },
      };
    }
  }
  return best?.tag ?? null;
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
 * The caps both halves of the boundary apply, as `shared/file-limits.json`
 * states them; a test on each side holds them equal. They were spelled three
 * times — a literal here, `DOWNLOAD_MAX_BYTES` in Rust and a number baked
 * into the catalogue copy — which is exactly the drift the shared-constant
 * rule exists to stop.
 */
export const DOWNLOAD_MAX_BYTES = 104_857_600;
export const PREVIEW_MAX_BYTES = 524_288;
export const MAX_ENTRIES = 20_000;
