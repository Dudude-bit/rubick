import { describe, expect, it } from "vitest";

import { buildDeepLink, parseDeepLink } from "./deep-link";

describe("buildDeepLink", () => {
  /** A context with a slash in it, an EKS ARN, would split into extra segments and open nothing. */
  it("encodes the context as one segment and keeps the page's own query", () => {
    const link = buildDeepLink(
      "arn:aws:eks:eu-central-1:123:cluster/prod",
      "/pods/shop/payments?tab=logs",
      new Date("2026-09-07T03:39:00.000Z")
    );
    expect(link).toBe(
      "rubick://open/arn%3Aaws%3Aeks%3Aeu-central-1%3A123%3Acluster%2Fprod/pods/shop/payments?tab=logs&t=2026-09-07T03%3A39%3A00Z"
    );
    expect(parseDeepLink(link)).toEqual({
      context: "arn:aws:eks:eu-central-1:123:cluster/prod",
      path: "/pods/shop/payments?tab=logs",
      capturedAt: new Date("2026-09-07T03:39:00.000Z"),
    });
  });
});

describe("parseDeepLink", () => {
  /** Case must survive: `Prod-EU` and `prod-eu` are two contexts in one kubeconfig. */
  it("keeps the context's case", () => {
    expect(
      parseDeepLink("rubick://open/Prod-EU/nodes/ip-10-0-1-1")?.context
    ).toBe("Prod-EU");
  });

  /** A link from another scheme or host must not be mistaken for a place in this app. */
  it("refuses anything that is not rubick://open", () => {
    expect(parseDeepLink("https://open/x/pods/a/b")).toBeNull();
    expect(parseDeepLink("rubick://other/x/pods/a/b")).toBeNull();
    expect(parseDeepLink("rubick://open/")).toBeNull();
    expect(parseDeepLink("not a url")).toBeNull();
  });

  /** A path that climbs out of the app's routes is not a place in the app. */
  it("never yields a path with dot segments, and refuses an undecodable one", () => {
    const climbed = parseDeepLink("rubick://open/ctx/pods/../../../settings");
    expect(climbed?.path ?? "/").not.toContain("..");
    expect(parseDeepLink("rubick://open/ctx/pods/%E0%A4%A")).toBeNull();
  });

  /** A link without a time is still a link; a bad time is not a time. */
  it("leaves capturedAt null when absent or unreadable", () => {
    expect(parseDeepLink("rubick://open/ctx/pods/a/b")?.capturedAt).toBeNull();
    expect(parseDeepLink("rubick://open/ctx/pods/a/b?t=yesterday")).toEqual({
      context: "ctx",
      path: "/pods/a/b",
      capturedAt: null,
    });
  });
});
