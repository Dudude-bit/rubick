import { describe, expect, it } from "vite-plus/test";

import { translate } from "@/i18n";
import type { T } from "@/i18n/useT";
import type { PodInfo } from "@/generated/types";
import { podsMark } from "./detail-tab";

const t: T = (section, key, values) => translate("en", section, key, values);

const running = {
  name: "ledger-67666b5cf5-m26dr",
  status: { display: "Running" },
} as PodInfo;

describe("a Pods tab's mark", () => {
  /**
   * Marco's ledger: its pods were refused, the tab said "Pods 0" and its
   * body said they could not be listed. Fails if a read that answered
   * nothing is counted as none, or a read still on its way as zero.
   */
  it("marks a pod list that could not be read as not checked, not as none", () => {
    expect(podsMark([], t, { error: new Error("pods is forbidden") })).toEqual({
      shows: "unchecked",
      says: "Could not read this workload's pods.",
    });
    expect(podsMark([], t, { pending: true })).toBeUndefined();
    expect(podsMark([], t)).toEqual({ shows: "count", of: 0 });
  });

  /** The body keeps the rows a read found before the next one failed, and so does the count. Fails if the two part. */
  it("counts the pods the body still shows after a failed re-read", () => {
    expect(podsMark([running], t, { error: new Error("timeout") })).toEqual({
      shows: "count",
      of: 1,
    });
  });
});
