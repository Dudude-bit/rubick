import { describe, expect, it } from "vite-plus/test";

import { translate } from "@/i18n";
import type { T } from "@/i18n/useT";
import { RelatedShort } from "@/integrations";
import {
  gatherRelated,
  relatedMark,
  type RelatedObjects,
} from "./useRelatedObjects";

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

describe("a supplier that read part of its answer", () => {
  const subject = {
    group: "cert-manager.io",
    kind: "Certificate",
    namespace: "shop",
    name: "web",
  };
  const issuer = {
    relation: "relIssuedBy" as const,
    kind: "Issuer",
    name: "ca",
    namespace: "shop",
    group: "cert-manager.io",
  };

  /**
   * cert-manager knows the Issuer and the Secret from the object, and reads
   * the Ingresses for the rest. Fails if a refused Ingress list drops those
   * two rows, or leaves the list looking whole.
   */
  it("keeps the rows it has and says the list is short", async () => {
    const refused = new Error("ingresses is forbidden");
    const gathered = await gatherRelated(
      [
        () => Promise.reject(new RelatedShort([issuer], refused)),
        () => Promise.resolve(null),
      ],
      subject
    );

    expect(gathered).toEqual({
      claimed: true,
      stated: [issuer],
      short: refused,
    });
  });

  /** Any other failure is still the whole answer failing. */
  it("fails whole on a failure that carries no rows", async () => {
    await expect(
      gatherRelated([() => Promise.reject(new Error("boom"))], subject)
    ).rejects.toThrow("boom");
  });
});
