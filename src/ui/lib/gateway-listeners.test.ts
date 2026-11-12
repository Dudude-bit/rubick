import { describe, expect, it } from "vite-plus/test";

import type { ListenerInfo } from "@/generated/types";
import { pickListeners, routeUrlsOn } from "./gateway-listeners";

const listener = (over: Partial<ListenerInfo> = {}): ListenerInfo => ({
  name: "web",
  port: 80,
  protocol: "HTTP",
  hostname: null,
  tlsMode: null,
  certificateRefs: [],
  allowedNamespaces: "All",
  attachedRoutes: null,
  conditions: [],
  fromListenerSet: null,
  ...over,
});

const http = (hostnames: string[], paths = ["/"]) => ({
  kind: "HTTPRoute",
  hostnames,
  paths,
});

describe("the listeners a parentRef points at", () => {
  const team = { name: "team", namespace: "shop" };
  const listeners = [
    listener({ name: "web", port: 80 }),
    listener({ name: "tls", port: 443, protocol: "HTTPS" }),
    listener({ name: "web", port: 8080, fromListenerSet: team }),
  ];

  /** A route through a ListenerSet was composed against the Gateway's own listeners, and another set's sectionName matched. */
  it("reaches only the set's own listeners through a ListenerSet", () => {
    expect(
      pickListeners(listeners, { set: team, sectionName: "web", port: null })
    ).toEqual([listeners[2]]);
  });

  /** A sectionName or a port narrows to that listener, and naming neither reaches all of them. */
  it("narrows by section, then by port, and otherwise takes every listener", () => {
    const pick = (sectionName: string | null, port: number | null) =>
      pickListeners(listeners, { set: null, sectionName, port }).map(
        (l) => l.port
      );
    expect(pick("tls", null)).toEqual([443]);
    expect(pick(null, 8080)).toEqual([8080]);
    expect(pick(null, null)).toEqual([80, 443, 8080]);
  });
});

describe("the addresses an HTTPRoute hands out", () => {
  /** door-shut.gw.test was served on :8000 and the card offered no address for it at all. */
  it("writes the listener's port where it is not the scheme's own", () => {
    expect(
      routeUrlsOn(http(["door-shut.gw.test"]), [
        listener({ port: 8000, hostname: "*.gw.test" }),
      ])
    ).toEqual(["http://door-shut.gw.test:8000/"]);
    expect(
      routeUrlsOn(http(["shop.example"], ["/api", "/"]), [
        listener({ port: 443, protocol: "HTTPS" }),
      ])
    ).toEqual(["https://shop.example/api", "https://shop.example/"]);
  });

  /** A route with no hostnames is answered on the listener's name, and a wildcard route on a named listener under it. */
  it("takes the listener's own name where the route names none or only a wildcard", () => {
    const named = [listener({ hostname: "shop.example" })];
    expect(routeUrlsOn(http([]), named)).toEqual(["http://shop.example/"]);
    expect(routeUrlsOn(http(["*.example"]), named)).toEqual([
      "http://shop.example/",
    ]);
  });

  /** An address nobody can paste, or one the listener never answers, is no address. */
  it("hands out nothing for a wildcard, a name the listener does not cover, or a protocol a browser cannot open", () => {
    expect(
      routeUrlsOn(http(["*.example"]), [listener({ hostname: "*.example" })])
    ).toEqual([]);
    expect(
      routeUrlsOn(http(["shop.other"]), [listener({ hostname: "*.example" })])
    ).toEqual([]);
    expect(
      routeUrlsOn(http(["shop.example"]), [listener({ protocol: "TLS" })])
    ).toEqual([]);
    expect(
      routeUrlsOn({ ...http(["shop.example"]), kind: "GRPCRoute" }, [
        listener(),
      ])
    ).toEqual([]);
  });
});
