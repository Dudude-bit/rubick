import { describe, expect, it } from "vite-plus/test";

import type { CostBasis } from "@/generated/types";
import { translate } from "@/i18n";
import type { T } from "@/i18n/useT";
import { estimatePicture } from "@/lib/cost";
import { efficiencyOf } from "@/lib/efficiency";
import {
  costLineWords,
  efficiencyWords,
  money,
  partOf,
  pictureNotes,
  usedLines,
} from "./cost-words";

const t: T = (section, key, values) => translate("en", section, key, values);

const refused: CostBasis = {
  nodes: [],
  nodesUnread: null,
  heldUnread: null,
  jobsUnread: null,
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
  unclaimed: { count: 0, bytes: 0 },
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

describe("the cost line of a workload whose cost read failed", () => {
  /**
   * The per-workload read failed and the totals stood: each workload's line
   * said "No OpenCost series priced its pods", sending the reader to the
   * prices for what was a failed read. Fails if the failure is worded as a
   * missing price.
   */
  it("says the read failed, with the reason", () => {
    const one = {
      ...refused,
      unread: [],
      workloads: [
        {
          key: {
            namespace: "shop",
            group: "apps",
            kind: "Deployment",
            name: "web",
          },
          pods: 1,
          cpu: 100,
          memory: 1,
          gpus: 0,
          claimBytes: 0,
        },
      ],
    };
    const picture = {
      ...estimatePicture(one, prices, null),
      workloads: [
        {
          key: one.workloads[0]!.key,
          pods: 1,
          perHour: null,
          atLeast: false,
          parts: {},
          unpriced: [],
          unknown: [],
          requests: { cpu: 100, memory: 1 },
        },
      ],
      workloadsFailed: "query timed out",
    };
    expect(
      costLineWords(
        picture,
        { namespace: "shop", group: "apps", kind: "Deployment", name: "web" },
        t
      )
    ).toBe("Could not read what this costs: query timed out");
  });
});

describe("a CronJob while the Jobs could not be listed", () => {
  /**
   * Pods could be read and Jobs not: each run is billed to its Job, and the
   * CronJob's page said "Not in the cost read yet". The page and the line
   * say the Jobs were refused. Fails if a refused Job list reads as nothing
   * of the CronJob running.
   */
  it("says the Jobs could not be listed, on the page and on its line", () => {
    const picture = estimatePicture(
      {
        ...refused,
        unread: [],
        jobsUnread: { code: "PERMISSION_DENIED", message: "jobs is forbidden" },
      },
      prices,
      null
    );
    expect(pictureNotes(picture, t).join(" ")).toContain(
      "The Jobs could not be listed (jobs is forbidden)"
    );
    expect(
      costLineWords(
        picture,
        { namespace: "shop", group: "batch", kind: "CronJob", name: "nightly" },
        t
      )
    ).toBe(
      "Not known: the Jobs that run it could not be listed (jobs is forbidden)."
    );
  });
});

describe("a peak summed over several pods", () => {
  /** A bound is said as one, as a percentage and as a quantity. Fails if it reads as the peak. */
  it("says at most beside it", () => {
    const e = efficiencyOf(
      1000,
      200,
      800,
      "2020-01-01T00:00:00Z",
      Date.now(),
      true
    );
    expect(efficiencyWords(e, t)).toBe("20% average, at most 80% peak");
    expect(usedLines(e, "cpu", t)).toEqual([
      "200m average",
      "at most 800m peak",
    ]);
  });
});

describe("a part nobody could read", () => {
  /** Unread storage is "Not known", not "none" and not "not priced". Fails if its cell says either. */
  it("says not known in its cell", () => {
    const row = {
      parts: { cpu: 0.01 },
      unpriced: [],
      unknown: ["storage" as const],
    };
    expect(money(partOf(row, "storage"), "", t)).toBe("Not known");
    expect(money(partOf({ ...row, unknown: [] }, "storage"), "", t)).toBe(
      "none"
    );
  });
});
