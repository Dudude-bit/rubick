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
  share,
  totalOf,
  troubleWords,
  usedLines,
  usedWords,
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
    expect(costLineWords(picture, { namespace: "bank" }, t)).toEqual({
      words: "Could not read what this costs.",
      unread: true,
    });
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
    ).toEqual({ words: "Could not read what this costs.", unread: true });
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
    ).toEqual({
      words: "Could not read what this costs: query timed out",
      unread: true,
    });
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
    ).toEqual({
      words:
        "Not known: the Jobs that run it could not be listed (jobs is forbidden).",
      unread: true,
    });
  });
});

describe("a peak summed over several pods", () => {
  /** A bound is said as one, as a percentage and as a quantity. Fails if it reads as the peak. */
  it("says at most beside it", () => {
    const e = efficiencyOf(1000, 200, 800, "2020-01-01T00:00:00Z", Date.now(), {
      peakAtMost: true,
    });
    expect(efficiencyWords(e, t)).toBe("20% average, at most 80% peak");
    expect(usedLines(e, "cpu", t)).toEqual([
      "200m average",
      "at most 800m peak",
    ]);
  });

  /** A workload that requests nothing still shows what it used. Fails if its summed peak reads as the peak. */
  it("says at most beside it where nothing was requested", () => {
    const e = efficiencyOf(0, 200, 800, "2020-01-01T00:00:00Z", Date.now(), {
      peakAtMost: true,
    });
    expect(usedLines(e, "cpu", t)).toEqual([
      "200m average",
      "at most 800m peak",
    ]);
    expect(usedWords(e, "cpu", t)).toBe("200m average · at most 800m peak");
  });
});

describe("figures read from some of a workload's pods", () => {
  /** A sum over two of three pods says so, and is not "at most". Fails if it reads as the workload's. */
  it("says how many pods they were read from", () => {
    const e = efficiencyOf(1000, 200, 800, "2020-01-01T00:00:00Z", Date.now(), {
      podsRead: { read: 2, of: 3 },
    });
    expect(efficiencyWords(e, t)).toBe(
      "20% average, 80% peak, from 2 of its 3 pods"
    );
    expect(usedLines(e, "cpu", t)).toEqual([
      "200m average",
      "800m peak, from 2 of its 3 pods",
    ]);
  });
});

describe("a namespace with no total for want of a read", () => {
  /**
   * Nothing of it priced and its storage not read: its total, share and
   * line said "not priced" or 0. Fails if any of the three says other than
   * that it is not known.
   */
  it("says not known in its total and its share, and on its line in amber", () => {
    const row = {
      namespace: "vault",
      perHour: null,
      atLeast: false,
      parts: {},
      unpriced: [],
      unknown: ["storage" as const],
      share: null,
    };
    expect(money(totalOf(row), "", t)).toBe("Not known");
    expect(share(row, t)).toBe("Not known");
    expect(share({ ...row, unknown: [], unpriced: ["cpu" as const] }, t)).toBe(
      "not priced"
    );
    const picture = {
      ...estimatePicture(refused, prices, null),
      unread: [],
      namespaces: [row],
    };
    expect(costLineWords(picture, { namespace: "vault" }, t)).toEqual({
      words: "Could not read what this costs.",
      unread: true,
    });
  });
});

describe("a priced row's share where the whole is not known", () => {
  /** The row is priced; what is not known is the whole. Fails if its share says "not priced", or a floor's share reads as the share. */
  it("says not known and why, and at most of a floor", () => {
    const row = {
      perHour: 0.05,
      unpriced: [],
      unknown: [],
      share: "noTotal" as const,
    };
    expect(share(row, t)).toBe("not known: no total");
    expect(share({ ...row, share: { of: 0.25, atMost: true } }, t)).toBe(
      "at most 25%"
    );
    expect(share({ ...row, share: { of: 0.25, atMost: false } }, t)).toBe(
      "25%"
    );
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

describe("node prices that the last answer lacked, before a read that failed", () => {
  /** The reason for the estimate is from the answer before a failed read, and says so. Fails if the failure goes unsaid. */
  it("says the read after it failed", () => {
    const trouble = {
      kind: "noNodePrices" as const,
      vendor: "opencost",
      endpoint: "http://prom:9090",
      lastFailed: "query timed out",
    };
    expect(troubleWords(trouble, t)).toBe(
      "OpenCost in Prometheus at http://prom:9090 priced none of this cluster's nodes in the last read that answered; the read after it failed (query timed out)."
    );
    expect(troubleWords({ ...trouble, lastFailed: null }, t)).toBe(
      "OpenCost in Prometheus at http://prom:9090 prices none of this cluster's nodes: it found no price list for them."
    );
  });
});
