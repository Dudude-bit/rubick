import { describe, expect, it } from "vitest";

import { DANGER_CLUSTER_COLOR } from "@/lib/cluster-identity";
import type { ShareTargetInfo } from "@/generated/types";
import {
  needsAcknowledgement,
  readyToPublish,
  targetColor,
} from "./share-targets";

const target = (over: Partial<ShareTargetInfo>): ShareTargetInfo =>
  ({
    id: "t1",
    label: "Team wiki",
    host: "reports.example.com",
    public: false,
    hasKey: true,
    ...over,
  }) as ShareTargetInfo;

describe("how a target is told from another", () => {
  /**
   * The red is reserved: in this feature it means "anyone with the link can
   * read it". The colour came from `clusterColor`, whose production rule
   * hands that same red to any name containing "prod" — so a private target
   * at `reports.prod.example.com` wore the warning meant for a public one.
   */
  it("keeps the reserved colour for a target anyone can read", () => {
    expect(targetColor(target({ public: true }))).toBe(DANGER_CLUSTER_COLOR);
    expect(
      targetColor(target({ public: false, host: "reports.prod.example.com" }))
    ).not.toBe(DANGER_CLUSTER_COLOR);
  });

  it("gives two hosts two colours", () => {
    expect(targetColor(target({ host: "a.example.com" }))).not.toBe(
      targetColor(target({ host: "b.example.com" }))
    );
  });

  /** The rule the dialog asks before it lets anything be sent. */
  it("says a target with no key is not ready", () => {
    expect(readyToPublish(target({ hasKey: false }))).toBe(false);
    expect(readyToPublish(target({ hasKey: true }))).toBe(true);
  });

  /** Every time, not once in settings: this report is not the last one. */
  it("asks a public target to be acknowledged", () => {
    expect(needsAcknowledgement(target({ public: true }))).toBe(true);
    expect(needsAcknowledgement(target({ public: false }))).toBe(false);
  });
});
