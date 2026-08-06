import type { ReactNode } from "react";

/**
 * The data behind a metadata block. Kept apart from the components that
 * render it so a page can build its rows without importing a component
 * module, and so the render file stays exclusively components.
 */

export type KeyValueTone = "ok" | "warn" | "err" | "info";

/** The one place a tone becomes a colour, shared by every block that takes one. */
export const TONE_CLASS: Record<KeyValueTone, string> = {
  ok: "text-ok",
  warn: "text-warn",
  err: "text-err",
  info: "text-info",
};

export interface KeyValue {
  /**
   * A node, not just a string: an endpoints row is keyed by its address, and
   * an address is a thing you copy.
   */
  label: ReactNode;
  value: ReactNode;
  /** Identifiers — names, images, IPs, versions — read as mono. */
  mono?: boolean;
  /** Colour the value. Reserve it for the row that is actually wrong. */
  tone?: KeyValueTone;
}

/**
 * Labels, annotations and selectors are all string maps whose values are
 * identifiers, so they are always mono and always sorted — a map arrives in
 * whatever order the API serialised it, and a block that reorders itself
 * between polls is unreadable.
 */
export function recordToKeyValues(record: Record<string, string>): KeyValue[] {
  return Object.entries(record)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([label, value]) => ({ label, value, mono: true }));
}
