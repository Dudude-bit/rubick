import { replaceEqualDeep } from "@tanstack/react-query";

const written = new WeakSet<object>();

/** A list a watch wrote, whose untouched rows are already the objects they were. */
export function watched<T extends object>(value: T): T {
  written.add(value);
  return value;
}

/**
 * Structural sharing, except for a watch's write. A row inserted or deleted
 * shifts every row after it, and the deep comparison matched each against
 * its old neighbour and handed back a copy: half of a 10 000-row list new
 * objects for one new pod.
 */
export function shareStructure(previous: unknown, next: unknown): unknown {
  return typeof next === "object" && next !== null && written.has(next)
    ? next
    : replaceEqualDeep(previous, next);
}
