import { describe, expect, it } from "vitest";

import { translate } from "@/i18n";
import type { T } from "@/i18n/useT";
import { secretKeysSection, secretTypeOf } from "./secret-share";

const t: T = (section, key, values) => translate("en", section, key, values);

describe("a Secret's keys table", () => {
  /** Only the name reaches the file: no value, and no size that would hint at one. */
  it("carries key names and nothing else about them", () => {
    const section = secretKeysSection(["username", "password"], t);
    if (section.body.type !== "table") throw new Error("expected a table");
    expect(section.body.columns).toHaveLength(1);
    expect(section.body.rows).toEqual([
      { cells: [{ text: "username", mono: true }] },
      { cells: [{ text: "password", mono: true }] },
    ]);
  });
});

describe("a Secret's type", () => {
  it("drops the kubernetes.io/ prefix, the same as the page's own badge", () => {
    expect(
      secretTypeOf({
        name: "s",
        namespace: "ns",
        uid: "u",
        type: "kubernetes.io/tls",
        dataKeys: [],
        labels: {},
        annotations: {},
        createdAt: null,
      }).text
    ).toBe("tls");
  });
});
