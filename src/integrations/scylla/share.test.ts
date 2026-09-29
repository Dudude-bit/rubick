import { describe, expect, it } from "vitest";

import { translate } from "@/i18n";
import type { T } from "@/i18n/useT";
import { nodeConfigsSection } from "./share";

const t: T = (section, key, values) => translate("en", section, key, values);

describe("what the Scylla screen tells Share about NodeConfigs", () => {
  /** A refused NodeConfig list returned no section: "every node is tuned". */
  it("marks the NodeConfigs unread when their list was refused", () => {
    expect(
      nodeConfigsSection({ ok: false, reason: "nodeconfigs is forbidden" }, t)
        ?.unread
    ).toBe("nodeconfigs is forbidden");
  });

  it("marks the NodeConfigs unread while they are still being read", () => {
    expect(nodeConfigsSection(undefined, t)?.unread).toBe(
      "Still being read when the report was made."
    );
  });

  it("reports nothing when the NodeConfigs were read and there are none", () => {
    expect(nodeConfigsSection({ ok: true, items: [] }, t)).toBeNull();
  });
});
