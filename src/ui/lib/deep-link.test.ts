import { describe, expect, it } from "vite-plus/test";

import { buildDeepLink, parseDeepLink } from "./deep-link";

const ARN = "arn:aws:eks:eu-central-1:123:cluster/prod";
const ARN_SEGMENT = encodeURIComponent(ARN);

describe("buildDeepLink", () => {
  /** A context with a slash in it, an EKS ARN, would split into extra segments and open nothing. */
  it("encodes the context as one segment and keeps the page's own query", () => {
    const link = buildDeepLink(
      `/c/${ARN_SEGMENT}/pods/shop/payments?tab=logs`,
      new Date("2026-09-07T03:39:00.000Z")
    );
    expect(link).toBe(
      "rubick://open/c/arn%3Aaws%3Aeks%3Aeu-central-1%3A123%3Acluster%2Fprod/pods/shop/payments?tab=logs&t=2026-09-07T03%3A39%3A00Z"
    );
    expect(parseDeepLink(link)).toEqual({
      context: ARN,
      path: `/c/${ARN_SEGMENT}/pods/shop/payments?tab=logs`,
      capturedAt: new Date("2026-09-07T03:39:00.000Z"),
    });
  });

  /** The router hands over an address encoded once; encoding it again would name another cluster. */
  it("never encodes an already encoded segment twice", () => {
    const link = buildDeepLink(`/c/${ARN_SEGMENT}/nodes/n1`);
    expect(link).not.toContain("%25");
    expect(parseDeepLink(link)?.context).toBe(ARN);
  });
});

describe("parseDeepLink", () => {
  /** Case must survive: `Prod-EU` and `prod-eu` are two contexts in one kubeconfig. */
  it("keeps the context's case", () => {
    expect(
      parseDeepLink("rubick://open/c/Prod-EU/nodes/ip-10-0-1-1")?.context
    ).toBe("Prod-EU");
  });

  /** A link from another scheme or host must not be mistaken for a place in this app. */
  it("refuses anything that is not rubick://open", () => {
    expect(parseDeepLink("https://open/c/x/pods/a/b")).toBeNull();
    expect(parseDeepLink("rubick://other/c/x/pods/a/b")).toBeNull();
    expect(parseDeepLink("rubick://open/")).toBeNull();
    expect(parseDeepLink("not a url")).toBeNull();
  });

  /** Only an address inside a cluster is a place a link can open. */
  it("refuses a path that does not name a cluster first", () => {
    expect(parseDeepLink("rubick://open/ctx/pods/a/b")).toBeNull();
    expect(parseDeepLink("rubick://open/c/")).toBeNull();
    expect(parseDeepLink("rubick://open/settings/clusters")).toBeNull();
  });

  /** A path that climbs out of the app's routes is not a place in the app. */
  it("never yields a path with dot segments, and refuses an undecodable one", () => {
    const climbed = parseDeepLink("rubick://open/c/ctx/pods/../../../settings");
    expect(climbed?.path ?? "/").not.toContain("..");
    expect(parseDeepLink("rubick://open/c/ctx/pods/%E0%A4%A")).toBeNull();
  });

  /**
   * A link opens unattended, so it must never carry a param that makes the
   * destination act. `?shell=<container>` and `?tab=shell` both open an exec
   * session into a container the moment the pod page mounts — a change to the
   * cluster from a link someone was handed. Only view-selection params survive.
   */
  it("drops the shell param and the shell tab, keeps read-only view params", () => {
    expect(
      parseDeepLink("rubick://open/c/ctx/pods/ns/api?shell=app")?.path
    ).toBe("/c/ctx/pods/ns/api");
    expect(
      parseDeepLink("rubick://open/c/ctx/pods/ns/api?tab=shell")?.path
    ).toBe("/c/ctx/pods/ns/api");
    // The safe ones are preserved.
    expect(
      parseDeepLink("rubick://open/c/ctx/pods/ns/api?tab=logs")?.path
    ).toBe("/c/ctx/pods/ns/api?tab=logs");
    expect(
      parseDeepLink("rubick://open/c/ctx/integrations?vendor=argocd&type=app")
        ?.path
    ).toBe("/c/ctx/integrations?vendor=argocd&type=app");
    // The router reads a quoted value as the word inside it, so the quotes
    // do not make it another tab.
    expect(
      parseDeepLink("rubick://open/c/ctx/pods/ns/api?tab=%22shell%22")?.path
    ).toBe("/c/ctx/pods/ns/api");
    expect(
      parseDeepLink("rubick://open/c/ctx/pods/ns/api?tab=%20%22shell%22")?.path
    ).toBe("/c/ctx/pods/ns/api");
    // An unknown param is not forwarded either — allowlist, not blocklist.
    expect(
      parseDeepLink("rubick://open/c/ctx/pods/ns/api?exec=1&shell=app&tab=logs")
        ?.path
    ).toBe("/c/ctx/pods/ns/api?tab=logs");
  });

  /** A link without a time is still a link; a bad time is not a time. */
  it("leaves capturedAt null when absent or unreadable", () => {
    expect(
      parseDeepLink("rubick://open/c/ctx/pods/a/b")?.capturedAt
    ).toBeNull();
    expect(parseDeepLink("rubick://open/c/ctx/pods/a/b?t=yesterday")).toEqual({
      context: "ctx",
      path: "/c/ctx/pods/a/b",
      capturedAt: null,
    });
  });
});
