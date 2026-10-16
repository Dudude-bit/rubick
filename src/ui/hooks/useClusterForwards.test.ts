import { describe, expect, it } from "vite-plus/test";

import type { PortForwardSessionInfo } from "@/generated/types";
import { orphansIn } from "./useClusterForwards";

const session = (
  id: string,
  localPort: number,
  remotePort: number,
  via: PortForwardSessionInfo["via"]
): PortForwardSessionInfo => ({
  id,
  context: "prod",
  pod: "prom-0",
  namespace: "mon",
  localPort,
  remotePort,
  autoReconnect: true,
  createdAt: "2026-10-05T00:00:00Z",
  via,
});

const preference = {
  namespace: "mon",
  service: "prom",
  remotePort: 80,
  localPort: 20500,
  autoStart: false,
};

describe("the tunnels a reconnect leaves behind", () => {
  /**
   * A Service forward reports the pod-side port, its targetPort. Matched on
   * that, a Service on 80 in front of 9090 never found its old tunnel, and a
   * pod forward in the namespace that happened to use 80 was stopped.
   */
  it("are the forwards through the same Service port, never a pod forward on the same number", () => {
    const sessions = [
      session("old", 20400, 9090, { kind: "service", name: "prom", port: 80 }),
      session("kept", 20500, 9090, { kind: "service", name: "prom", port: 80 }),
      session("pod", 20600, 80, { kind: "pod" }),
      session("other", 20700, 9090, {
        kind: "service",
        name: "loki",
        port: 80,
      }),
    ];
    expect(orphansIn(sessions, preference, 20500)).toEqual(["old"]);
  });
});
