import { describe, expect, it } from "vitest";

import { ofSameCluster } from "./previous-answer";
import { queryKeys } from "./query-keys";

/**
 * Without the context check this is `keepPreviousData`, and the rail read
 * `Pods 51` beside the name of a cluster whose service account may not list
 * pods at all — the previous cluster's total, under the new cluster's name.
 */
describe("ofSameCluster", () => {
  it("keeps an answer the same cluster gave", () => {
    const keep = ofSameCluster<string>("prod-eu");
    expect(
      keep("51 pods", { queryKey: queryKeys.clusterOverview("prod-eu") })
    ).toBe("51 pods");
  });

  it("drops an answer another cluster gave", () => {
    const keep = ofSameCluster<string>("staging-eu");
    expect(
      keep("51 pods", { queryKey: queryKeys.clusterOverview("prod-eu") })
    ).toBeUndefined();
  });

  it("has nothing to keep before the first answer", () => {
    const keep = ofSameCluster<string>("prod-eu");
    expect(keep(undefined, undefined)).toBeUndefined();
  });
});
