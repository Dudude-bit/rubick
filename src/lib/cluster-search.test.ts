import { describe, it, expect } from "vitest";

import {
  matchContext,
  matchesAllClusters,
  parseBang,
  rankContexts,
  splitMarks,
} from "./cluster-search";

const ARN = "arn:aws:eks:us-east-1:1234:cluster/prod";
const GKE = "gke_acme-prod_europe-west1_main";

describe("the ranking ladder", () => {
  it("puts the kind of match ahead of the size of the difference", () => {
    // The whole reason the ladder exists: by edit distance alone `staging`
    // (6 away from `prod`) beats the ARN (35 away) that literally contains
    // the word, and the reader is handed the cluster they did not mean.
    const ranked = rankContexts("prod", [
      "staging",
      ARN,
      "prod-eu",
      "prod",
      GKE,
    ]);

    expect(ranked.map((match) => match.context)).toEqual([
      "prod",
      "prod-eu",
      GKE,
      ARN,
    ]);
    expect(ranked.map((match) => match.rung)).toEqual([
      "exact",
      "prefix",
      "substring",
      "substring",
    ]);
  });

  it("refuses a name on no rung rather than showing it far away", () => {
    expect(matchContext("prod", "staging")).toBeNull();
    expect(rankContexts("prod", ["staging", "minikube"])).toEqual([]);
  });

  it("refuses a needle longer than the name", () => {
    expect(matchContext("production-eu", "prod")).toBeNull();
  });

  it("breaks a tie inside a rung by distance, and never across rungs", () => {
    // Both contain the word; the shorter name is the closer one. A longer
    // name never climbs a rung by being close, and a closer name never
    // outranks a better kind of match.
    const ranked = rankContexts("prod", [ARN, GKE, "eu-prod"]);
    expect(ranked.map((match) => match.context)).toEqual(["eu-prod", GKE, ARN]);
    expect(ranked[1].distance).toBeLessThan(ranked[2].distance);
  });

  it("orders equal distances by name so the list never reshuffles itself", () => {
    const ranked = rankContexts("prod", ["b-prod", "a-prod"]);
    expect(ranked.map((match) => match.context)).toEqual(["a-prod", "b-prod"]);
  });

  it("matches without regard to case but marks the original text", () => {
    const match = matchContext("prod", "ACME-PROD-EU");
    expect(match?.rung).toBe("substring");
    expect(match?.marks).toEqual([[5, 9]]);
    expect(splitMarks("ACME-PROD-EU", match!.marks)).toEqual([
      { text: "ACME-", matched: false },
      { text: "PROD", matched: true },
      { text: "-EU", matched: false },
    ]);
  });

  it("marks the run so the reason for the ranking is visible", () => {
    expect(matchContext("prod", ARN)?.marks).toEqual([[35, 39]]);
    expect(splitMarks(ARN, matchContext("prod", ARN)!.marks)).toEqual([
      { text: "arn:aws:eks:us-east-1:1234:cluster/", matched: false },
      { text: "prod", matched: true },
    ]);
  });

  it("marks a subsequence as the separate runs it actually is", () => {
    const match = matchContext("prd", "prod-eu");
    expect(match?.rung).toBe("subsequence");
    expect(match?.marks).toEqual([
      [0, 2],
      [3, 4],
    ]);
  });

  it("keeps the kubeconfig's own order when nothing has been typed yet", () => {
    const contexts = ["staging", ARN, "prod-eu"];
    expect(rankContexts("", contexts).map((m) => m.context)).toEqual(contexts);
  });
});

describe("the bang", () => {
  it("is only a bang at the start of the query", () => {
    expect(parseBang("!prod")).toEqual({ needle: "prod", rest: "" });
    expect(parseBang("!")).toEqual({ needle: "", rest: "" });
    expect(parseBang("payments!")).toBeNull();
    expect(parseBang("")).toBeNull();
  });

  it("keeps whatever was typed after the cluster", () => {
    expect(parseBang("!prod-eu payments api")).toEqual({
      needle: "prod-eu",
      rest: "payments api",
    });
  });

  it("offers every cluster for `*`, and while the word is unfinished", () => {
    expect(matchesAllClusters("*")).toBe(true);
    expect(matchesAllClusters("")).toBe(true);
    expect(matchesAllClusters("al")).toBe(true);
    expect(matchesAllClusters("all")).toBe(true);
    expect(matchesAllClusters("prod")).toBe(false);
  });
});

describe("a cluster that has been renamed", () => {
  const called = (name: string) => (context: string) =>
    context === ARN ? name : undefined;

  it("is found by the name this person gave it", () => {
    const ranked = rankContexts("payments", [ARN, GKE], called("payments"));

    expect(ranked.map((match) => match.context)).toEqual([ARN]);
    expect(ranked[0].viaAlias).toBe(true);
    expect(ranked[0].matched).toBe("payments");
  });

  it("is still found by the context name it actually has", () => {
    const ranked = rankContexts("us-east", [ARN, GKE], called("payments"));

    expect(ranked[0].context).toBe(ARN);
    expect(ranked[0].viaAlias).toBe(false);
    expect(ranked[0].matched).toBe(ARN);
  });

  it("climbs on whichever of its two names goes higher", () => {
    // `pay` is a prefix of the alias and only a subsequence of the ARN, so
    // the alias is the rung the cluster is offered on.
    const match = matchContext("pay", ARN, "payments");
    expect(match?.rung).toBe("prefix");
    expect(match?.viaAlias).toBe(true);
  });

  it("marks the name it matched, not the other one", () => {
    const match = matchContext("ment", ARN, "payments");
    expect(splitMarks(match!.matched, match!.marks)).toEqual([
      { text: "pay", matched: false },
      { text: "ment", matched: true },
      { text: "s", matched: false },
    ]);
  });

  it("is still offered with nothing typed after the bang", () => {
    const match = matchContext("", ARN, "payments");
    expect(match?.matched).toBe("payments");
    expect(match?.marks).toEqual([]);
  });

  it("is refused when neither name is on the ladder", () => {
    expect(matchContext("zzz", ARN, "payments")).toBeNull();
  });
});
