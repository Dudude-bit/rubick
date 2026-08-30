/**
 * The ListenerSet shape, run over what a real cluster actually said.
 *
 * The fixture is written by `dump_listenerset_scene` in
 * `src-tauri/tests/live_route_status.rs` from a kind cluster built to match a
 * maintainer's setup: a bare Gateway in one namespace, a ListenerSet in
 * another carrying the TLS listener, and a route that names the set rather
 * than the Gateway. Its parentRef has no namespace, so it resolves to the
 * route's own — the case a hand-written fixture would most easily get wrong.
 */

import { describe, expect, it } from "vitest";

import { routesBoard } from "./route-rows";
import { routeTraces } from "./route-trace";
import { translate } from "@/i18n";
import type { T } from "@/i18n/useT";
import type {
  GatewayClassInfo,
  GatewayInfo,
  RouteInfo,
} from "@/generated/types";
import live from "./__fixtures__/live-listenerset.json";

const t = ((section, key, values) =>
  translate("en", section, key, values)) as T;

const scene = live as unknown as {
  classes: GatewayClassInfo[];
  gateways: GatewayInfo[];
  routes: RouteInfo[];
};

const sources = () => ({
  gateways: scene.gateways,
  classes: scene.classes,
  topologyKnown: true,
  backing: { services: [], published: [], backingKnown: false },
});

describe("a route through a ListenerSet, as the cluster reports it", () => {
  it("is the shape the fix was written for", () => {
    expect(scene.routes[0].parentRefs[0].kind).toBe("ListenerSet");
    expect(scene.routes[0].parentRefs[0].namespace).toBe(null);
    expect(scene.gateways[0].namespace).toBe("edge");
    expect(scene.gateways[0].listenerSets).toEqual([
      { name: "app-tls", namespace: "apps" },
    ]);
  });

  it("traces against the Gateway across the namespace boundary", () => {
    const traces = routeTraces(scene.routes[0], sources(), t);

    expect(traces).toHaveLength(1);
    expect(traces[0].gateway.name).toBe("shared");
    expect(traces[0].gateway.namespace).toBe("edge");
    expect(traces[0].steps[0].state).toBe("ok");
    expect(traces[0].steps[1].state).toBe("ok");
  });

  it("is judged rather than filed as a mesh route", () => {
    const board = routesBoard([scene.routes[0]], sources(), t);

    expect(board.mesh).toHaveLength(0);
    const row = [...board.serving, ...board.notServing][0];
    expect(row.via).toContain("shared");
    expect(row.viaRef?.name).toBe("shared");
    expect(row.viaGhost).toBe(null);
  });
});
