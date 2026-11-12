// @vitest-environment jsdom
import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vite-plus/test";

import { makeRouter } from "./router";

describe("the router the app runs on", () => {
  /**
   * The router keeps a route's component mounted while only its params
   * change, so a ConfigMap page moved from one ConfigMap to another carried
   * an open editor along and saved its text into the second. Fails if two
   * objects at one route share a mounted page, or if a page that names no
   * object, the shell around every page among them, is given a key to
   * remount by.
   */
  it("mounts a page anew for each object, and no page that names none", () => {
    const keyOf = makeRouter(new QueryClient()).options
      .defaultRemountDeps as (at: {
      params: Record<string, string>;
    }) => unknown;
    const key = (params: Record<string, string>) =>
      JSON.stringify(keyOf({ params }));
    const prod = { cluster: "k", namespace: "prod", name: "app-config" };

    expect(key(prod)).not.toBe(key({ ...prod, namespace: "staging" }));
    expect(key(prod)).not.toBe(key({ ...prod, name: "other" }));
    expect(key({ cluster: "k", name: "node-1" })).not.toBe(
      key({ cluster: "k", name: "node-2" })
    );
    expect(key(prod)).toBe(key({ ...prod }));
    expect(keyOf({ params: { cluster: "k" } })).toBeUndefined();
    expect(keyOf({ params: { cluster: "k", resource: "widgets" } })).toBe(
      undefined
    );
  });
});
