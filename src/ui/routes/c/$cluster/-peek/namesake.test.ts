import { readFileSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";

import { RESOURCE_REGISTRY } from "@/lib/resource-registry";
import { CODE_FILES } from "@/test/source-files";

const KINDS = RESOURCE_REGISTRY.map((entry) => entry.kind).join("|");
const BARE_KIND = new RegExp(
  [
    "toKind\\(target\\.kind\\)",
    "\\.has\\(target\\.kind\\)",
    `target\\.kind\\s*[!=]==\\s*(?:ResourceType\\.|"(?:${KINDS})")`,
  ].join("|"),
  "g"
);

describe("the peek's files", () => {
  /**
   * A target names its kind as the cluster does, and Knative's Service,
   * Istio's Gateway and Volcano's Job are not the registry's. Asked by that
   * name, the panel drew the core Service's traffic under the Knative one.
   * The registry's kind is `builtInKindOf(target)`, which reads the CRD too.
   */
  it("never take a target's kind name for the registry's kind of that name", () => {
    const taken = CODE_FILES.filter((path) =>
      path.startsWith("src/ui/routes/c/$cluster/-peek/")
    ).flatMap((path) =>
      [...readFileSync(path, "utf8").matchAll(BARE_KIND)].map(
        ([found]) => `${path}: ${found}`
      )
    );
    expect(taken).toEqual([]);
  });
});
