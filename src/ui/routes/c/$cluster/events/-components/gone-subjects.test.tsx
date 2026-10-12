import { describe, expect, it, vi } from "vite-plus/test";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

import type { Story } from "@/lib/event-stories";
import { useClusterStore } from "@/stores/clusterStore";
import { testQueryClient } from "@/test/render";

const getObjectMetadata = vi.hoisted(() => vi.fn());
vi.mock("@/lib/commands", () => ({ commands: { getObjectMetadata } }));

const { useGoneSubjects } = await import("./gone-subjects");

const story = (name: string, state: Story["state"] = "settled") =>
  ({
    state,
    subject: {
      kind: "HorizontalPodAutoscaler",
      name,
      namespace: "lena-sandbox",
      byName: false,
    },
  }) as Story;

describe("which stories' objects were deleted", () => {
  /**
   * Lena's deleted HPA read amber "settled". Fails if a story whose object
   * the cluster answered "not found" is not reported gone, or if a refused
   * read, a present object or a story with no trouble left is.
   */
  it("is what the cluster answered not found, and nothing it did not", async () => {
    useClusterStore.setState({ isConnected: true });
    getObjectMetadata.mockImplementation(async (_kind, apiVersion, name) => {
      expect(apiVersion).toBe("autoscaling/v2");
      if (name === "hello-web")
        throw { code: "NOT_FOUND", message: "not found" };
      if (name === "refused")
        throw { code: "PERMISSION", message: "forbidden" };
      return { labels: {}, annotations: {} };
    });
    const client = testQueryClient();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    const stories = [
      story("hello-web"),
      story("refused"),
      story("api"),
      story("done-and-gone", "done"),
    ];
    const { result } = renderHook(() => useGoneSubjects(stories), {
      wrapper,
    });
    await waitFor(() =>
      expect([...result.current]).toEqual([
        "lena-sandbox/HorizontalPodAutoscaler/hello-web",
      ])
    );
    expect(getObjectMetadata).toHaveBeenCalledTimes(3);
  });
});
