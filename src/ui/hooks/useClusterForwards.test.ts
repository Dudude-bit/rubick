// @vitest-environment jsdom
import { createElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const tunnels = vi.hoisted(() => ({
  sessions: [] as unknown[],
  save: vi.fn(async () => undefined),
  forward: vi.fn(
    async (
      _context: string,
      _service: unknown,
      _ports: number[],
      keep?: number
    ) => ({
      namespace: "mon",
      service: "prom",
      remotePort: 80,
      localPort: keep === 20000 ? 20001 : (keep ?? 20001),
      subpath: "",
      url: "",
    })
  ),
}));

vi.mock("@/lib/commands", () => ({
  commands: {
    listPortForwards: vi.fn(async () => tunnels.sessions),
    listServices: vi.fn(async () => [{ name: "prom", namespace: "mon" }]),
    stopPortForward: vi.fn(async () => undefined),
  },
}));

vi.mock("@/integrations", () => ({
  forward: tunnels.forward,
  normalisedSubpath: (subpath?: string) => subpath ?? "",
  connectOf: () => ({ read: async () => null, save: tunnels.save }),
}));

import type { PortForwardSessionInfo } from "@/generated/types";
import { useClusterForwardStore } from "@/stores/clusterForwardStore";
import { useClusterStore } from "@/stores/clusterStore";
import { commands } from "@/lib/commands";
import { orphansIn, useClusterForwards, wake } from "./useClusterForwards";

const session = (
  id: string,
  localPort: number,
  remotePort: number,
  via: PortForwardSessionInfo["via"],
  context = "prod"
): PortForwardSessionInfo => ({
  id,
  context,
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

const viaProm = { kind: "service", name: "prom", port: 80 } as const;

beforeEach(() => {
  tunnels.sessions = [];
  tunnels.forward.mockClear();
  tunnels.save.mockClear();
  useClusterForwardStore.setState({ forwards: {} });
  useClusterStore.setState({ currentContext: "staging", isConnected: true });
});

describe("the tunnels a reconnect leaves behind", () => {
  /**
   * A Service forward reports the pod-side port, its targetPort. Matched on
   * that, a Service on 80 in front of 9090 never found its old tunnel, and a
   * pod forward in the namespace that happened to use 80 was stopped.
   */
  it("are the forwards through the same Service port, never a pod forward on the same number", () => {
    const sessions = [
      session("old", 20400, 9090, viaProm),
      session("kept", 20500, 9090, viaProm),
      session("pod", 20600, 80, { kind: "pod" }),
      session("other", 20700, 9090, {
        kind: "service",
        name: "loki",
        port: 80,
      }),
    ];
    expect(orphansIn(sessions, "prod", preference, 20500)).toEqual(["old"]);
  });

  /**
   * Waking staging's Prometheus stopped prod's, under prod's parked tab,
   * because both clusters run `mon/prom:80`. Fails if another cluster's
   * tunnel is ever taken for this one's leftover.
   */
  it("are this cluster's own, never another's through a namesake Service", () => {
    const sessions = [session("prod's", 20400, 9090, viaProm, "prod")];
    expect(orphansIn(sessions, "staging", preference, null)).toEqual([]);
  });
});

describe("a saved address another cluster's tunnel is answering", () => {
  /**
   * Prod and staging were both saved on localhost:20000. With prod's tunnel
   * up under its parked tab, staging's wake saw "already up" and staging's
   * Alerts drew prod's. Fails if a port held by another cluster's tunnel
   * counts as this cluster's forward being up.
   */
  it("gets a tunnel of its own, and the address follows it", async () => {
    tunnels.sessions = [session("prod's", 20000, 9090, viaProm, "prod")];

    const found = await wake("prometheus", "staging", {
      ...preference,
      localPort: 20000,
    });

    // By name: the window can be on another cluster when the start arrives.
    expect(tunnels.forward.mock.calls[0][0]).toBe("staging");
    expect(found.localPort).toBe(20001);
    expect(tunnels.save).toHaveBeenCalledWith(
      "staging",
      expect.objectContaining({ url: "http://localhost:20001" })
    );
    expect(
      useClusterForwardStore.getState().forwards.staging?.prometheus?.localPort
    ).toBe(20001);
  });

  /** Fails if the guard above stops this cluster's own tunnel being reused. */
  it("reuses this cluster's own tunnel on it", async () => {
    tunnels.sessions = [session("own", 20000, 9090, viaProm, "staging")];
    await wake("prometheus", "staging", { ...preference, localPort: 20000 });
    expect(tunnels.forward).not.toHaveBeenCalled();
  });

  /**
   * Nobody visits staging's Prometheus page to wake it, and autoStart is
   * off, so every other page read prod's numbers through prod's tunnel.
   * Fails if landing on a cluster leaves such an address on the other
   * cluster's tunnel.
   */
  it("is woken when the cluster lands, asked to start or not", async () => {
    tunnels.sessions = [session("prod's", 20000, 9090, viaProm, "prod")];
    useClusterForwardStore.setState({
      forwards: {
        staging: { prometheus: { ...preference, localPort: 20000 } },
      },
    });
    useClusterStore.setState({ currentContext: "staging", isConnected: true });
    const client = new QueryClient();
    renderHook(() => useClusterForwards(), {
      wrapper: ({ children }: { children: ReactNode }) =>
        createElement(QueryClientProvider, { client }, children),
    });

    await waitFor(() => expect(tunnels.forward).toHaveBeenCalled());
  });
});

describe("a wake the window moved on from", () => {
  const moved = () => useClusterStore.setState({ currentContext: "prod" });

  /**
   * Every call a wake makes goes to the window's cluster: after Ctrl+Tab the
   * tunnel opened on prod's namesake Service and was saved as staging's
   * Prometheus. Fails if a wake opens a tunnel once the window has left.
   */
  it("opens no tunnel on the cluster the window moved to", async () => {
    vi.mocked(commands.listServices).mockImplementationOnce(async () => {
      moved();
      return [];
    });

    await wake("prometheus", "staging", preference);

    expect(tunnels.forward).not.toHaveBeenCalled();
  });

  /** Fails if a tunnel that came up after the window left is filed as the first cluster's address. */
  it("does not file a tunnel opened after the move as the first cluster's", async () => {
    tunnels.forward.mockImplementationOnce(async () => {
      moved();
      return { ...preference, localPort: 20009, subpath: "", url: "" };
    });

    await wake("prometheus", "staging", preference);

    expect(tunnels.save).not.toHaveBeenCalled();
    expect(useClusterForwardStore.getState().forwards.staging).toBeUndefined();
  });
});
