import { describe, expect, it } from "vite-plus/test";

import { translate } from "@/i18n";
import type { T } from "@/i18n/useT";

import { scopeCellPx } from "./crd-scope";

describe("the CRDs Scope column", () => {
  /** Lena read "в пространс…" and "на весь клас…" beside free room. Fails if the column's floor stops holding either scope whole in either language. */
  it.each(["en", "ru"] as const)("holds both scopes whole in %s", (lang) => {
    const t: T = (section, key, values) =>
      translate(lang, section, key, values);
    for (const key of ["namespaced", "clusterWide"] as const)
      expect(scopeCellPx(t)).toBeGreaterThanOrEqual(
        t("apiResources", key).length * 6.6 + 20
      );
  });
});
