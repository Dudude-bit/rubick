/**
 * The colour that says *which container* a line came from.
 *
 * Assigned by position in the pod's container list rather than hashed:
 * a pod has a handful of containers and the list is stable for its
 * lifetime, so walking a pre-spread ring gives maximum separation where
 * a hash would happily hand two sidecars neighbouring hues.
 *
 * The hues are the cool half of the identity ring in `resource-identity`
 * and are omitted from the warm end for the same reason: red through
 * yellow belong to `--err` and `--warn`, and a container rule that reads
 * as a severity would collide with the one other channel this row has.
 * Saturation and lightness live in `--ctr-s` / `--ctr-l` so both themes
 * track their own canvas.
 */
const CONTAINER_HUES = [250, 184, 318, 132, 202, 274, 92, 340, 160, 224];

/** `hsl(...)` for a container's rule, legend swatch and detail dot. */
export function containerColor(index: number): string {
  return `hsl(${CONTAINER_HUES[index % CONTAINER_HUES.length]} var(--ctr-s) var(--ctr-l))`;
}

/**
 * Container name -> its colour, for the whole pod at once. Built from the
 * pod's declared list so a container that has not written a line yet still
 * owns its hue in the legend, and so the mapping does not shift when it
 * finally does.
 */
export function containerColors(
  containers: readonly string[]
): Map<string, string> {
  return new Map(containers.map((name, i) => [name, containerColor(i)]));
}
