/**
 * The trace, run over what a real cluster actually said.
 *
 * The fixture beside this file is written by
 * `src-tauri/tests/live_route_status.rs` from a kind cluster whose controller
 * claims a class and programs a gateway but writes no status for the route —
 * the shape reported from a live Netbird cluster, where every TCPRoute read
 * "the route is invisible to the data plane" while carrying traffic.
 *
 * Fixtures written by hand agree with whatever the person writing them
 * believed. This one does not: it is the backend's own output, so if the Rust
 * side ever reads that cluster differently, this stops passing.
 */

import { describe, expect, it } from "vitest";

import { routeTraces } from "./route-trace";
import { translate } from "@/i18n";
import type { T } from "@/i18n/useT";
import type {
  GatewayClassInfo,
  GatewayInfo,
  RouteInfo,
} from "@/generated/types";
import live from "./__fixtures__/live-route-status.json";

const t = ((section, key, values) =>
  translate("en", section, key, values)) as T;

const scene = live as unknown as {
  classes: GatewayClassInfo[];
  gateways: GatewayInfo[];
  routes: RouteInfo[];
};

describe("the Netbird shape, as the cluster really reports it", () => {
  const trace = () =>
    routeTraces(
      scene.routes[0],
      {
        gateways: scene.gateways,
        classes: scene.classes,
        topologyKnown: true,
        backing: { services: [], published: [], backingKnown: false },
      },
      t
    )[0];

  /** What the backend read, restated as the assumptions this fix rests on. */
  it("is the shape the fix was written for", () => {
    expect(scene.classes[0].accepted).toBe(true);
    expect(scene.gateways[0].addresses).toEqual([]);
    expect(scene.routes[0].parents).toEqual([]);
  });

  it("does not call the route dead", () => {
    const found = trace();

    expect(found.serving).toBe(true);
    expect(found.stopStep).toBe(null);
    // Nobody checked, and it says so rather than showing a green tick.
    expect(found.servingKnown).toBe(false);
  });

  /** The two steps the reader complained about, in order. */
  it("names what it cannot read instead of what it thinks is broken", () => {
    const steps = trace().steps;

    expect(steps[0].state).toBe("ok"); // the class is claimed
    expect(steps[1].state).toBe("blind"); // no address published
    expect(steps[1].say).toContain("publishes no address");
    expect(steps[2].state).toBe("blind"); // no route status written
    expect(steps[2].say).toContain("no verdict");
    // And the rest are reached now, rather than reading NOT REACHED.
    expect(steps[3].state).not.toBe("off");
  });
});
