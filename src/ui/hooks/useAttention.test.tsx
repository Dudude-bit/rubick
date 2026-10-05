import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import type { ClusterOverview } from "@/generated/types";

const commands = vi.hoisted(() => ({
  getClusterOverview: vi.fn(),
  listServiceHealthInputs: vi.fn(),
  listIngressHealthInputs: vi.fn(),
  listAutoscalersIn: vi.fn(),
  listPersistentVolumeClaimsIn: vi.fn(),
  resolveIngressClass: vi.fn(),
  getTlsCertificates: vi.fn(),
}));

vi.mock("@/lib/commands", () => ({ commands }));

const { useAttention } = await import("./useAttention");
const { useClusterStore } = await import("@/stores/clusterStore");

const OVERVIEW = {
  problems: [],
  problemsTruncated: 0,
  unread: [],
} as unknown as ClusterOverview;

const EMPTY = { rows: [], unread: [] };

function wrapper() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}

beforeEach(() => {
  for (const command of Object.values(commands)) command.mockReset();
  commands.getClusterOverview.mockResolvedValue(OVERVIEW);
  commands.listServiceHealthInputs.mockResolvedValue(EMPTY);
  commands.listIngressHealthInputs.mockResolvedValue(EMPTY);
  commands.listAutoscalersIn.mockResolvedValue(EMPTY);
  commands.listPersistentVolumeClaimsIn.mockResolvedValue(EMPTY);
  useClusterStore.setState({
    isConnected: true,
    currentContext: "prod",
    namespaceScope: ["shop"],
  });
});

describe("the reads behind Needs attention", () => {
  /**
   * Marco's token may list pods and not autoscalers. The refusal has to
   * reach the list as a kind not checked, with the cluster's code, rather
   * than as a scope with no autoscaler in trouble. Fails if a failed read is
   * handed on as an empty one.
   */
  it("carries a refused list as a kind not checked", async () => {
    commands.listAutoscalersIn.mockRejectedValue({
      code: "PERMISSION_DENIED",
      message: "horizontalpodautoscalers.autoscaling is forbidden",
    });

    const { result } = renderHook(() => useAttention(), { wrapper: wrapper() });

    await waitFor(() =>
      expect(
        result.current?.checks.find(
          (check) => check.kind === "HorizontalPodAutoscaler"
        )?.state
      ).toBe("unread")
    );
    const hpa = result.current!.checks.find(
      (check) => check.kind === "HorizontalPodAutoscaler"
    )!;
    expect(hpa.unread[0].code).toBe("PERMISSION_DENIED");
    expect(result.current!.complete).toBe(false);
    expect(commands.listAutoscalersIn).toHaveBeenCalledWith(["shop"]);
  });

  /** Every list answered is the one complete answer, and only once they all have. */
  it("is complete once every list has answered, and not before", async () => {
    let answer: (value: typeof EMPTY) => void = () => {};
    commands.listPersistentVolumeClaimsIn.mockReturnValue(
      new Promise((resolve) => (answer = resolve))
    );

    const { result } = renderHook(() => useAttention(), { wrapper: wrapper() });

    await waitFor(() => expect(result.current).not.toBeNull());
    await waitFor(() =>
      expect(
        result.current!.checks.filter((check) => check.state !== "read")
      ).toEqual([
        { kind: "PersistentVolumeClaim", state: "reading", unread: [] },
      ])
    );
    expect(result.current!.complete).toBe(false);

    answer(EMPTY);
    await waitFor(() => expect(result.current!.complete).toBe(true));
  });
});
