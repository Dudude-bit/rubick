import { describe, expect, it } from "vite-plus/test";

import type { CostBasis } from "@/generated/types";
import { translate } from "@/i18n";
import type { T } from "@/i18n/useT";
import { estimatePicture } from "@/lib/cost";
import { costLineWords } from "./cost-words";

const t: T = (section, key, values) => translate("en", section, key, values);

const refused: CostBasis = {
  nodes: [],
  nodesUnread: null,
  heldUnread: null,
  namespaces: [],
  workloads: [],
  rest: null,
  waiting: 0,
  unread: [
    {
      namespace: "bank",
      code: "PERMISSION_DENIED",
      message: "pods is forbidden",
    },
  ],
  volumeBytes: 0,
  volumeCount: 0,
  unclaimed: [],
  volumesUnread: null,
  claimsUnread: [],
  servedFrom: "list",
};

const prices = {
  cpu: 0.04,
  memory: 0.005,
  storage: null,
  gpu: null,
  currency: "",
};

describe("the cost line of an object in a namespace that was refused", () => {
  /**
   * `bank`'s pods were refused: its page said "Nothing of it runs on a
   * node", and a workload in it "Not in the cost read yet". Both are the
   * refusal. Fails if a refused namespace reads as one with nothing in it.
   */
  it("says the cost could not be read, for the namespace and for a workload in it", () => {
    const picture = estimatePicture(refused, prices, null);
    expect(costLineWords(picture, { namespace: "bank" }, t)).toBe(
      "Could not read what this costs."
    );
    expect(
      costLineWords(
        picture,
        {
          namespace: "bank",
          group: "apps",
          kind: "Deployment",
          name: "teller",
        },
        t
      )
    ).toBe("Could not read what this costs.");
  });
});
