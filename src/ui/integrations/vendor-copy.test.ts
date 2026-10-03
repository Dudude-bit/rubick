import { describe, expect, it } from "vitest";

import { en } from "@/i18n/catalogue";

/**
 * Every vendor module, loaded the way the registry loads them.
 *
 * By glob rather than by list: the point of this file is to notice a vendor
 * nobody remembered to mention, and a hand-written list would be the second
 * place to forget it.
 */
const MODULES = import.meta.glob<Record<string, unknown>>("./*/index.ts", {
  eager: true,
});

/**
 * Every vendor a module exports, however it exports it. Three of them are
 * named exports rather than defaults, and looking only at `default` is how
 * this test first reported their copy as orphaned.
 */
function vendorsIn(module: Record<string, unknown>): { gives?: string }[] {
  return Object.values(module)
    .filter(
      (value): value is { extension?: { gives?: string } } =>
        typeof value === "object" && value !== null && "extension" in value
    )
    .map((vendor) => vendor.extension ?? {});
}

describe("what each extension promises the reader", () => {
  /**
   * The blurb is a catalogue key now, and a key is still a string: nothing in
   * the type system stops a render site putting `prometheusGives` on screen
   * where the sentence belongs. This end catches the other half — a key that
   * names nothing at all.
   */
  it("names a line the catalogue actually carries", () => {
    const missing = Object.entries(MODULES).flatMap(([path, module]) =>
      vendorsIn(module).flatMap(({ gives }) =>
        gives === undefined || gives in en.vendor ? [] : [`${path}: ${gives}`]
      )
    );
    expect(missing).toEqual([]);
  });

  /**
   * And no line left behind by a vendor that has gone. An orphan reads as
   * translated copy for something the app no longer offers, which is worse
   * than nothing: somebody will translate it again next time.
   */
  it("leaves no line belonging to nobody", () => {
    const claimed = new Set(
      Object.values(MODULES)
        .flatMap(vendorsIn)
        .map(({ gives }) => gives)
        .filter((gives): gives is string => gives !== undefined)
    );
    const orphans = Object.keys(en.vendor).filter((key) => !claimed.has(key));
    expect(orphans).toEqual([]);
  });
});
