/**
 * Who mounts a volume where, said once.
 *
 * A mount was printed once per container, so the two containers of a pod
 * mounting one volume at one path printed that path twice — and the path in
 * question is `/var/run/secrets/kubernetes.io/serviceaccount`, on every pod
 * in the cluster. The container name was the only thing that differed and it
 * sat in the middle of the repetition.
 *
 * Grouped by exactly what a line prints: the path, the subPath, whether it is
 * read-only, and whether it arrived through a projection. Anything the line
 * does not print — which `spec.volumes` entry a mount came through — cannot
 * make two lines look different, so it does not split them either.
 *
 * Shared rather than done in each renderer because the Volumes block and the
 * Connections tab were repeating the same mount for the same reason, and a
 * grouping rule that holds in one place and not the other is how the two
 * spellings drift apart. What each renderer keeps is its own wording: one
 * writes a sentence, the other fills a column.
 */

export interface MountLike {
  container: string;
  path: string;
  readOnly: boolean;
  subPath: string | null;
  /** Only where the caller says a projected mount differently. */
  projected?: boolean;
}

export interface MountGroup<T> {
  key: string;
  /** The first mount of the group; every field a line prints is shared. */
  mount: T;
  /** Every container that mounts it that way, in the pod's own order. */
  containers: string[];
}

export function groupMounts<T extends MountLike>(mounts: T[]): MountGroup<T>[] {
  const groups = new Map<string, MountGroup<T>>();
  for (const mount of mounts) {
    const key = JSON.stringify([
      mount.path,
      mount.subPath,
      mount.readOnly,
      mount.projected ?? false,
    ]);
    const group = groups.get(key);
    if (!group) {
      groups.set(key, { key, mount, containers: [mount.container] });
    } else if (!group.containers.includes(mount.container)) {
      group.containers.push(mount.container);
    }
  }
  return [...groups.values()];
}

/**
 * The containers, or the fact that it is every one of them.
 *
 * `total` is the pod's whole container list, init containers included, and is
 * what makes "all containers" a checked claim rather than a guess — a caller
 * that does not know the denominator passes nothing and gets the names, which
 * are true either way.
 *
 * Where the line falls: a one-container pod has nothing to tell apart, so the
 * name is a column of the same word and is left off entirely. Where every
 * container mounts it — the service-account volume, on every pod in the
 * cluster — that is the fact, and it is shorter and steadier than the roster:
 * the same words on every pod, which the eye learns to skip. Names are for
 * the case they actually answer, which is *some* of the containers.
 */
export function mountedBy(containers: string[], total?: number): string {
  if (total !== undefined && containers.length === total) {
    return total === 1 ? "" : "all containers";
  }
  return containers.join(", ");
}
