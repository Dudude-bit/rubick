import { readFileSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";

import { CODE_FILES } from "@/test/source-files";

const read = (path: string) => readFileSync(path, "utf8");

/** Each `<Name …>` opening tag in `source`, whole. */
const tags = (source: string, name: string) =>
  [...source.matchAll(new RegExp(`<${name}\\b[^>]*>`, "g"))].map(
    ([tag]) => tag
  );

describe("a kind read from the cluster", () => {
  /**
   * `KindIcon`, `ResourceName`, `kindHue`, `kindGlyph` and `kindIcon` take a
   * bare kind name only with the segment it is served at, so the compiler
   * finds every site. Saying `undefined` there is the one way left to draw a
   * Knative Service as the core one: allowed where the kind is one the
   * Overview's own reads name, and nowhere it can be a custom kind.
   */
  it("is drawn by its name alone only where it cannot be a custom kind", () => {
    const BY_NAME =
      /crd=\{undefined\}|\bkind(?:Hue|Glyph|Icon)\([^()]*,\s*undefined\)/g;
    const said = CODE_FILES.flatMap((path) =>
      [...read(path).matchAll(BY_NAME)].map(() => path)
    );
    expect(said).toEqual([
      "src/ui/routes/c/$cluster/-overview/health.tsx",
      "src/ui/routes/c/$cluster/-overview/health.tsx",
      "src/ui/routes/c/$cluster/-overview/health.tsx",
    ]);
  });

  /**
   * An event names its object by kind, and Knative's Service, Volcano's Job
   * and OpenKruise's StatefulSet are not the built-ins of those names. Fails
   * if a reference on the Events screens is drawn or linked without the CRD
   * its group resolves to (`refOfNamed`).
   */
  it("is never referred to on the Events screens without the CRD of its group", () => {
    const bare = CODE_FILES.filter((path) =>
      path.startsWith("src/ui/routes/c/$cluster/events/-components/")
    ).flatMap((path) =>
      ["ResourceRef", "PastObjectRef"]
        .flatMap((name) => tags(read(path), name))
        .filter((tag) => !/\bcrd=/.test(tag))
        .map((tag) => `${path}: ${tag.split("\n")[0]}`)
    );
    expect(bare).toEqual([]);
  });
});
