import { describe, expect, it } from "vitest";

import { translate } from "@/i18n";
import type { T } from "@/i18n/useT";
import { configMapKeysSection } from "./config-map-share";

const t: T = (section, key, values) => translate("en", section, key, values);

describe("a ConfigMap's keys table", () => {
  /** A key's value never reaches the file; only its byte size does. */
  it("gives a size, never the value, for a key that was read", () => {
    const section = configMapKeysSection(
      ["app.ini"],
      {
        data: {
          values: { "app.ini": "secret=abc123" },
          withheld: {},
          binary: {},
        },
        error: null,
      },
      t
    );
    if (section.body.type !== "table") throw new Error("expected a table");
    const [key, size] = section.body.rows[0].cells;
    expect(key.text).toBe("app.ini");
    expect(size.text).not.toContain("secret");
    expect(size.text).toContain("Bytes");
  });

  /** A refused key must read as refused, not as a size of zero. */
  it("shows the refusal reason instead of a fake size for a withheld key", () => {
    const section = configMapKeysSection(
      ["tls.key"],
      {
        data: {
          values: {},
          withheld: { "tls.key": "private key" },
          binary: {},
        },
        error: null,
      },
      t
    );
    if (section.body.type !== "table") throw new Error("expected a table");
    expect(section.body.rows[0].cells[1].text).toBe("private key");
  });

  /** An empty table and a refused read are different answers. */
  it("marks the section unread on a refused read instead of an empty table", () => {
    const section = configMapKeysSection(
      ["app.ini"],
      { data: undefined, error: new Error("configmaps is forbidden") },
      t
    );
    expect(section.unread).toContain("forbidden");
  });
});
