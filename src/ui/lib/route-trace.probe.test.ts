import { describe, expect, it } from "vitest";

import { translate } from "@/i18n";
import type { T } from "@/i18n/useT";
import type { ResolveProbe, TcpProbe } from "@/generated/types";
import { probedReachable, type ProbeStep, type TraceStep } from "./route-trace";

const t: T = (section, key, values) => translate("en", section, key, values);

/** What the trace itself composes: the last mile, nobody has walked it. */
const unchecked: TraceStep = {
  id: "reachable",
  state: "blind",
  say: translate("en", "empty", "gwReachableUnchecked"),
  who: "machine",
} as TraceStep;

const idle = { status: "idle" } as const;
const resolved: ProbeStep<ResolveProbe> = {
  status: "finished",
  result: { resolved: ["203.0.113.9"], error: null, matchesGateway: true },
};
const connected: ProbeStep<TcpProbe> = {
  status: "finished",
  result: { ms: 42, error: null, reason: null },
};
const refused: ProbeStep<TcpProbe> = {
  status: "finished",
  result: { ms: null, error: null, reason: "refused" },
};

describe("the reachable step, once a probe has run", () => {
  /** The step and the panel under it are two renderings of one check, and
   *  the step is the static one. It kept saying "not checked yet" after the
   *  reader pressed Probe and watched the panel answer — reported against
   *  4.7.1 by a reader on Cloudflare. */
  it("stops saying not checked yet once the probe has answered", () => {
    const before = probedReachable(unchecked, idle, idle, t);
    expect(before.say).toContain("not checked yet");

    const after = probedReachable(unchecked, resolved, connected, t);
    expect(after.say).not.toContain("not checked yet");
    expect(after.say).toContain("answered");
  });

  /** A probe that failed says so, but never in red: this machine being
   *  unable to reach an address is evidence about this machine — its VPN,
   *  its firewall — as much as about the gateway. */
  it("marks a failed probe as a warning rather than a break", () => {
    const step = probedReachable(unchecked, resolved, refused, t);
    expect(step.state).toBe("warn");
    expect(step.say).toContain("nothing answered");
  });

  /** The verdict above the steps must not move. A probe from this machine is
   *  not what the cluster says — which is exactly why the step carries
   *  `who: "machine"` and `servingKnown` skips it. Rewriting the step's
   *  identity here would quietly make a laptop's success count as cluster
   *  evidence. */
  it("leaves the step's identity alone so the verdict cannot follow it", () => {
    const step = probedReachable(unchecked, resolved, connected, t);
    expect(step.id).toBe("reachable");
    expect(step.who).toBe("machine");
  });

  /** Resolved, not yet connected: the panel shows both rows and the step
   *  waits for the half that decides. */
  it("waits for the connect before it claims anything", () => {
    const step = probedReachable(unchecked, resolved, idle, t);
    expect(step).toBe(unchecked);
  });
});
