import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * `kindCount` renders its plural as `{kind}s`. That is right for `Gateway`
 * and `VirtualService`, and wrong for every kind ending in a consonant and a
 * `y` — `AzureIdentity` printed as `AzureIdentitys` on a live cluster, and
 * `CiliumNetworkPolicy` would have. A kind name is the cluster's to spell,
 * so the rule is not to bend it: a kind this key cannot pluralise says its
 * count in its own catalogue entry instead.
 *
 * Nothing else checks this. The key takes a string and the compiler is happy
 * with any of them.
 */
describe("the shared kind counter", () => {
  it("is handed only kinds an `s` actually pluralises", () => {
    const root = join(import.meta.dirname);
    const wrong: string[] = [];

    for (const vendor of readdirSync(root, { withFileTypes: true })) {
      if (!vendor.isDirectory()) continue;
      const facts = join(root, vendor.name, "facts.ts");
      let source: string;
      try {
        source = readFileSync(facts, "utf8");
      } catch {
        continue;
      }
      // `key: "kindCount"…` and the `kind: "X"` that follows it.
      for (const block of source.split('"kindCount"').slice(1)) {
        const kind = /kind:\s*"([^"]+)"/.exec(block.slice(0, 200))?.[1];
        if (kind && /[^aeiou]y$/i.test(kind)) {
          wrong.push(`${vendor.name}: ${kind} → ${kind}s`);
        }
      }
    }

    expect(wrong).toEqual([]);
  });
});
