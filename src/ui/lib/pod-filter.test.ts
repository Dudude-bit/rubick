import { describe, expect, it } from "vite-plus/test";

import { translate } from "@/i18n";
import type { T } from "@/i18n/useT";
import {
  narrowPods,
  outsideScope,
  podFilterOf,
  podFilterWords,
} from "./pod-filter";

const t: T = (section, key, values) => translate("en", section, key, values);

interface Pod {
  name: string;
  namespace: string;
  labels: Record<string, string>;
}

const PODS: Pod[] = [
  { name: "web-1", namespace: "net", labels: { role: "frontend" } },
  { name: "api-1", namespace: "net", labels: { app: "api" } },
  { name: "web-9", namespace: "shop", labels: { role: "frontend" } },
];

const names = (rows: Pod[]) => rows.map((pod) => pod.name);

describe("the Pods list narrowed to a selector", () => {
  /** The address a policy's pod count links to. */
  it("keeps the pods the selector matches in the namespaces named", () => {
    const filter = podFilterOf({ selector: "role=frontend", in: "net" });
    expect(names(narrowPods(PODS, filter))).toEqual(["web-1"]);
    expect(
      names(narrowPods(PODS, podFilterOf({ selector: "role=frontend" })))
    ).toEqual(["web-1", "web-9"]);
  });

  /** `?in=` alone is every pod there: the empty selector a URL cannot hold. */
  it("reads a namespace with no selector as every pod in it", () => {
    expect(names(narrowPods(PODS, podFilterOf({ in: "net" })))).toEqual([
      "web-1",
      "api-1",
    ]);
    expect(podFilterOf({})).toBeNull();
  });

  /**
   * Text that is not a selector shows no pod as matching. Showing every
   * pod under it would claim they all match. Fails if it falls through.
   */
  it("shows nothing as matching a selector it cannot read", () => {
    const filter = podFilterOf({ selector: "app in (api" });
    expect(filter?.selector).toBeNull();
    expect(narrowPods(PODS, filter)).toEqual([]);
  });

  it("names the namespaces the window is not looking at", () => {
    const filter = podFilterOf({ selector: "app=api", in: "net,shop" })!;
    expect(outsideScope(filter, [])).toEqual([]);
    expect(outsideScope(filter, ["net"])).toEqual(["shop"]);
    expect(outsideScope(podFilterOf({ selector: "a=b" })!, ["net"])).toEqual([
      "*",
    ]);
  });
});

describe("a pod filter in words", () => {
  /** The shared file's one line for what the banner above the list says. */
  it("names the selector and the namespaces, or every pod and every namespace", () => {
    expect(
      podFilterWords(
        { text: "app=web", selector: null, namespaces: ["shop", "web"] },
        t
      )
    ).toBe("Pods matching app=web in shop, web");
    expect(
      podFilterWords({ text: "", selector: null, namespaces: null }, t)
    ).toBe("Every pod in every namespace");
  });
});
