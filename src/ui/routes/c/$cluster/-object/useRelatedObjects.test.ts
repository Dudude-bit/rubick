import { describe, expect, it } from "vite-plus/test";

import { translate } from "@/i18n";
import type { T } from "@/i18n/useT";
import { relatedMark, type RelatedObjects } from "./useRelatedObjects";

const query = (over: Partial<RelatedObjects> = {}): RelatedObjects => ({
  claimed: false,
  related: [],
  isPending: false,
  error: null,
  ...over,
});

describe("a custom resource's Connections tab mark", () => {
  const t: T = (section, key, values) => translate("en", section, key, values);
  const owner: RelatedObjects["related"][number] = {
    relation: "relControlledBy",
    kind: "HelmRelease",
    name: "web",
    namespace: "shop",
    group: "helm.toolkit.fluxcd.io",
  };

  /** Fails if a list an integration could not finish wears its count as the whole. */
  it("counts a list short by a failed integration as a floor", () => {
    const short = { claimed: true, error: new Error("connection refused") };
    expect(
      relatedMark(query({ ...short, related: [owner] }), "Widget", t)
    ).toEqual({
      shows: "count",
      of: "1+",
    });
    expect(relatedMark(query(short), "Widget", t)).toEqual({
      shows: "unchecked",
      says: t("empty", "relatedShortBy", { kind: "Widget" }),
    });
    expect(
      relatedMark(query({ claimed: true, related: [owner] }), "Widget", t)
    ).toEqual({
      shows: "count",
      of: 1,
    });
  });
});
