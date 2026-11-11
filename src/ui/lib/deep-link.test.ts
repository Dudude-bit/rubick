import { describe, expect, it } from "vite-plus/test";

import { APP_SEARCH_KEYS } from "./app-search";
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
  it("refuses a link that names no cluster", () => {
    expect(parseDeepLink("rubick://open/c/")).toBeNull();
  });

  /**
   * Would break if links copied or shared by 4.11 to 4.21, which put the
   * cluster first and a section before the plural, were dropped: they sit
   * in chats, tickets and saved reports, and nothing said why they stopped
   * opening.
   */
  it("opens a link from 4.21 at the same place in its cluster", () => {
    expect(
      parseDeepLink(
        "rubick://open/arn%3Aaws%3Aeks%3Aeu%3A1%3Acluster%2Fprod/workloads/pods/shop/api?tab=logs&t=2026-09-01T10:00:00Z"
      )
    ).toMatchObject({
      context: "arn:aws:eks:eu:1:cluster/prod",
      path: "/c/arn%3Aaws%3Aeks%3Aeu%3A1%3Acluster%2Fprod/pods/shop/api?tab=logs",
    });
    expect(parseDeepLink("rubick://open/kind/events")?.path).toBe(
      "/c/kind/events"
    );
  });

  /** A path that climbs out of the app's routes is not a place in the app. */
  it("never yields a path with dot segments, and refuses an undecodable one", () => {
    const climbed = parseDeepLink("rubick://open/c/ctx/pods/../../../settings");
    expect(climbed?.path ?? "/").not.toContain("..");
    expect(parseDeepLink("rubick://open/c/ctx/pods/%E0%A4%A")).toBeNull();
  });

  /**
   * A link opens unattended, so it carries only params that pick a view. Dana's
   * link with `?tab=shell` landed on Overview: the Shell tab is a view now,
   * an offer that starts nothing. Fails if the shell tab is dropped, or if a
   * param outside the allowlist, `?shell=<container>` included, gets through.
   */
  it("keeps the tab a link names, Shell included, and drops every other param", () => {
    expect(
      parseDeepLink("rubick://open/c/ctx/pods/ns/api?tab=shell")?.path
    ).toBe("/c/ctx/pods/ns/api?tab=shell");
    expect(
      parseDeepLink("rubick://open/c/ctx/pods/ns/api?tab=logs")?.path
    ).toBe("/c/ctx/pods/ns/api?tab=logs");
    expect(
      parseDeepLink("rubick://open/c/ctx/integrations?vendor=argocd&type=app")
        ?.path
    ).toBe("/c/ctx/integrations?vendor=argocd&type=app");
    expect(
      parseDeepLink("rubick://open/c/ctx/pods/ns/api?shell=app")?.path
    ).toBe("/c/ctx/pods/ns/api");
    expect(
      parseDeepLink("rubick://open/c/ctx/pods/ns/api?exec=1&shell=app&tab=logs")
        ?.path
    ).toBe("/c/ctx/pods/ns/api?tab=logs");
  });

  /**
   * A policy's "selected pods" copied as a link reopened as every pod, with
   * no banner: the sender's link held the filter and the receiver dropped
   * it. Fails if a param that only narrows what is shown is stripped.
   */
  it("keeps the filters a link names, so a narrowed list reopens narrowed", () => {
    for (const query of [
      "selector=app%3Dweb&in=shop",
      "listOf=httproutes&names=shop%2Fa%2Cshop%2Fb",
      "kind=httproutes",
      "tab=changes&since=2026-10-12T11%3A44%3A56Z",
      "view=stories&range=6h&q=backoff",
    ]) {
      expect(parseDeepLink(`rubick://open/c/ctx/pods?${query}`)?.path).toBe(
        `/c/ctx/pods?${query}`
      );
    }
  });

  /**
   * The allowlist and the params the app reads are two lists. Fails when a
   * param is added to the app and nobody decided whether a link may carry
   * it: allow it, or name it here beside `shell` with the reason.
   */
  it("carries every param the app reads except the one that starts a shell", () => {
    const dropped = APP_SEARCH_KEYS.filter(
      (key) =>
        parseDeepLink(`rubick://open/c/ctx/pods?${key}=x`)?.path !==
        `/c/ctx/pods?${key}=x`
    );
    expect(dropped).toEqual(["shell"]);
  });

  /** An attached object's link opened its parent: fails if `view` is dropped on the way in. */
  it("keeps the view a link names", () => {
    expect(
      parseDeepLink(
        "rubick://open/c/ctx/horizontalpodautoscalers/ns/web?view=own&t=2026-10-12T11%3A44%3A56Z"
      )?.path
    ).toBe("/c/ctx/horizontalpodautoscalers/ns/web?view=own");
    expect(parseDeepLink("rubick://open/c/ctx/events?view=stories")?.path).toBe(
      "/c/ctx/events?view=stories"
    );
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
