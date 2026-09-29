import { describe, expect, it } from "vitest";

import { DANGER_CLUSTER_COLOR } from "@/lib/cluster-identity";
import type { ShareTargetInfo } from "@/generated/types";
import {
  needsAcknowledgement,
  objectKey,
  readyToPublish,
  reportLink,
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

describe("the key a published link is remembered against", () => {
  const object = (context: string) => ({
    subject: {
      kind: "Deployment",
      namespace: "kube-system",
      name: "coredns",
      context,
    },
    hero: { ref: {} },
    link: `rubick://open/${context}/workloads/deployments/kube-system/coredns?t=2026-09-28T23%3A15%3A41Z`,
  });

  /**
   * One draft per key, sent again on the next publish. Without the cluster
   * in it, publishing staging's coredns replaced the link colleagues were
   * reading about prod's with staging's names and IPs.
   */
  it("tells the same object on two clusters apart", () => {
    expect(objectKey(object("prod"))).not.toBe(objectKey(object("staging")));
    expect(objectKey(object("prod"))).toBe(objectKey(object("prod")));
  });

  /**
   * A screen's title is the same everywhere; its key is the route it was
   * taken on, without the moment, so a snapshot of Pods filtered by one
   * namespace never overwrites one of another.
   */
  it("keys a screen by where it was taken, not by its title or its moment", () => {
    const screen = (path: string, t: string) => ({
      subject: {
        kind: "Screen",
        namespace: null,
        name: "Pods",
        context: "prod",
      },
      hero: { ref: null },
      link: `rubick://open/prod/${path}?q=api&t=${t}`,
    });
    expect(objectKey(screen("pods", "1"))).toBe(objectKey(screen("pods", "2")));
    expect(objectKey(screen("pods", "1"))).not.toBe(
      objectKey(screen("workloads/deployments", "1"))
    );
    expect(objectKey(screen("pods", "1"))).toContain("q=api");
    expect(objectKey(screen("pods", "1"))).not.toContain("t=");
  });
});

describe("the link a target answers with", () => {
  /**
   * The target is somebody else's server, and the dialog opens its answer on
   * a click: an address that is not a web page is not a report link.
   */
  it("keeps a web address and refuses anything else", () => {
    expect(reportLink("https://abc123.postplan.dev")).toBe(
      "https://abc123.postplan.dev"
    );
    expect(reportLink("http://plans.internal/r/1")).toBe(
      "http://plans.internal/r/1"
    );
    for (const hostile of [
      "file:///etc/passwd",
      "javascript:alert(1)",
      "vscode://open?file=x",
      "not a url",
      "",
      null,
    ])
      expect(reportLink(hostile)).toBeNull();
  });
});
