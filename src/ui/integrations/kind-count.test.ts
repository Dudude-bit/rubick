import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

import { SOURCE_FILES } from "@/test/source-files";

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
    const wrong: string[] = [];
    const facts = SOURCE_FILES.filter((path) =>
      /^src\/integrations\/[^/]+\/facts\.ts$/.test(path)
    );
    expect(facts.length).toBeGreaterThan(0);

    for (const path of facts) {
      const vendor = path.split("/")[2];
      // `key: "kindCount"…` and the `kind: "X"` that follows it.
      for (const block of readFileSync(path, "utf8")
        .split('"kindCount"')
        .slice(1)) {
        const kind = /kind:\s*"([^"]+)"/.exec(block.slice(0, 200))?.[1];
        if (kind && /[^aeiou]y$/i.test(kind)) {
          wrong.push(`${vendor}: ${kind} → ${kind}s`);
        }
      }
    }

    expect(wrong).toEqual([]);
  });
});
