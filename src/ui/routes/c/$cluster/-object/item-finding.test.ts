import { describe, expect, it } from "vite-plus/test";

import { translate } from "@/i18n";
import type { T } from "@/i18n/useT";
import type { AttentionItem } from "@/lib/attention";
import { formatWhen } from "@/lib/utils";
import { itemFinding } from "./item-finding";

const t: T = (section, key, values) => translate("en", section, key, values);

const AT = new Date(2026, 0, 1, 22, 9, 16).getTime();

const unavailable: AttentionItem = {
  key: "Deployment/lab/api",
  tone: "err",
  kind: "Deployment",
  name: "api",
  namespace: "lab",
  reason: "Unavailable",
  detail: null,
  since: null,
  restarts: null,
  foldedPods: null,
  replaced: false,
  opens: { kind: "Deployment", name: "api", namespace: "lab" },
};

describe("a finding the peek and the page draw from a kept row", () => {
  /**
   * A red Unavailable turned amber on the peek and the page once its kind
   * could not be read again, as if the failed read made it milder. Fails if
   * a kept finding loses its severity, or does not say since when it is
   * known.
   */
  it("keeps its severity and says it was not rechecked, since when", () => {
    const finding = itemFinding(
      { ...unavailable, stale: true, lastKnown: { at: AT, refused: false } },
      t
    );
    expect(finding.tone).toBe("err");
    expect(finding.title).toBe(
      `Unavailable · not rechecked · last known at ${formatWhen(AT, "clock")}`
    );
  });
});
