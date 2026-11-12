import { describe, expect, it } from "vite-plus/test";

import { shortNamesOf } from "./kind-aliases";

describe("what a kind answers to", () => {
  /** The cluster's own short names win: a CRD's are known only to it. */
  it("takes the short names discovery listed", () => {
    expect(
      shortNamesOf({
        group: "cert-manager.io",
        plural: "certificates",
        shortNames: ["cert", "certs"],
      })
    ).toEqual(["cert", "certs"]);
  });

  /**
   * A cluster serving no aggregated discovery lists none, and `deploy`
   * found nothing. The table answers for the kinds the app has a type for.
   */
  it("falls back to kubectl's own for a typed kind discovery said nothing of", () => {
    expect(
      shortNamesOf({ group: "apps", plural: "deployments", shortNames: [] })
    ).toEqual(["deploy"]);
    expect(shortNamesOf({ group: "", plural: "nodes" })).toEqual(["no"]);
    expect(
      shortNamesOf({ group: "demo.example.com", plural: "widgets" })
    ).toEqual([]);
  });
});
