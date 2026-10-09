import { describe, expect, it } from "vite-plus/test";

import { translate } from "@/i18n";
import type { T } from "@/i18n/useT";
import { crd } from "./crd";

const ru: T = (section, key, values) => translate("ru", section, key, values);

describe("what Traefik's list cells say in Russian", () => {
  /** "2 suites" and "Default" were composed in code under a Russian header. */
  it("names the cipher suites in the reader's language", () => {
    const column = crd
      .columnsFor("TLSOption")
      .find((c) => c.id === "cipherSuites");
    expect(column?.cell?.(2, ru)).toBe("2 набора шифров");
    expect(column?.cell?.(0, ru)).toBe("По умолчанию");
  });
});
