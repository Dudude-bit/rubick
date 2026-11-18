import type { BinaryValue, ConfigData, Withheld } from "@/generated/types";
import { entryOf } from "@/lib/named";

/** What a read of a ConfigMap or Secret holds under one key. */
export interface HeldUnder {
  value?: string;
  withheld?: Withheld;
  binary?: BinaryValue;
}

/**
 * Each part only where it is the key's own. A key is the cluster's to
 * choose, and `constructor` or `toString` is not one because every object
 * has it: read from the prototype, a key read whole showed as withheld.
 */
export function heldUnder(
  read: Partial<ConfigData> | undefined,
  key: string
): HeldUnder {
  return {
    value: read?.values && entryOf(read.values, key),
    withheld: read?.withheld && entryOf(read.withheld, key),
    binary: read?.binary && entryOf(read.binary, key),
  };
}
