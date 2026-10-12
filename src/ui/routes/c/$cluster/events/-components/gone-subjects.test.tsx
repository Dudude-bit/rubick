import { describe, expect, it, vi } from "vite-plus/test";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

import type { Story } from "@/lib/event-stories";
import { queryKeys } from "@/lib/query-keys";
import { useClusterStore } from "@/stores/clusterStore";
import { testQueryClient } from "@/test/render";

const getObjectMetadata = vi.hoisted(() => vi.fn());
vi.mock("@/lib/commands", () => ({ commands: { getObjectMetadata } }));

const { HELD_FOR_MS, useGoneSubjects } = await import("./gone-subjects");

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

const NOT_FOUND = { code: "NOT_FOUND", message: "not found" };
const GONE = "lena-sandbox/HorizontalPodAutoscaler/hello-web";

function mount(stories: Story[], now: number) {
  const client = testQueryClient();
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const hook = renderHook(
    ({ at }: { at: number }) => useGoneSubjects(stories, at),
    { wrapper, initialProps: { at: now } }
  );
  return { client, ...hook };
}

describe("which stories' objects were deleted", () => {
  /**
   * Lena's deleted HPA read amber "settled". Fails if a story whose object
   * the cluster answered "not found" is not reported gone, or if a refused
   * read, a present object or a story with no trouble left is.
   */
  it("is what the cluster answered not found, and nothing it did not", async () => {
    useClusterStore.setState({ isConnected: true });
    getObjectMetadata.mockReset();
    getObjectMetadata.mockImplementation(async (_kind, apiVersion, name) => {
      expect(apiVersion).toBe("autoscaling/v2");
      if (name === "hello-web") throw NOT_FOUND;
      if (name === "refused")
        throw { code: "PERMISSION", message: "forbidden" };
      return { labels: {}, annotations: {} };
    });
    const { result } = mount(
      [
        story("hello-web"),
        story("refused"),
        story("api"),
        story("done-and-gone", "done"),
      ],
      Date.now()
    );
    await waitFor(() => expect([...result.current]).toEqual([GONE]));
    expect(getObjectMetadata).toHaveBeenCalledTimes(3);
  });

  /**
   * Lena's HPA, deleted for good while its story still burned, read red
   * "продолжается" for five minutes: only a settled story was asked. Fails
   * if a burning story's object is not read, or its "not found" not heard.
   */
  it("reads a burning story's object as well as a settled one's", async () => {
    useClusterStore.setState({ isConnected: true });
    getObjectMetadata.mockReset();
    getObjectMetadata.mockRejectedValue(NOT_FOUND);
    const { result } = mount(
      [story("hello-web", "stillHappening")],
      Date.now()
    );
    await waitFor(() => expect([...result.current]).toEqual([GONE]));
  });

  /**
   * An object deleted while its page stays open was read once, present, and
   * never again. Fails if the read is not repeated as the page's clock moves
   * past the time an answer is held, or is repeated before it.
   */
  it("reads an object again as the page's clock moves on, and not sooner", async () => {
    const at = Date.parse("2026-10-12T11:47:30Z");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(at);
    try {
      useClusterStore.setState({ isConnected: true });
      getObjectMetadata.mockReset();
      getObjectMetadata.mockResolvedValue({ labels: {}, annotations: {} });
      const { result, rerender } = mount(
        [story("hello-web", "stillHappening")],
        at
      );
      await waitFor(() => expect(getObjectMetadata).toHaveBeenCalledTimes(1));

      getObjectMetadata.mockRejectedValue(NOT_FOUND);
      rerender({ at: at + 1 });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(getObjectMetadata).toHaveBeenCalledTimes(1);

      vi.setSystemTime(at + HELD_FOR_MS + 1);
      rerender({ at: at + HELD_FOR_MS });
      await waitFor(() => expect([...result.current]).toEqual([GONE]));
      expect(getObjectMetadata).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * The Overview said "удалён" at once while the story waited for its next
   * read. Fails if an object the Overview's own check calls gone is not read
   * again before the page's clock would have come round.
   */
  it("reads an object again at once when the Overview's check calls it gone", async () => {
    useClusterStore.setState({
      isConnected: true,
      currentContext: "acme",
      namespaceScope: ["lena-sandbox"],
    });
    getObjectMetadata.mockReset();
    getObjectMetadata.mockResolvedValue({ labels: {}, annotations: {} });
    const { client, result } = mount(
      [story("hello-web", "stillHappening")],
      Date.now()
    );
    await waitFor(() => expect(getObjectMetadata).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(result.current.size).toBe(0);

    getObjectMetadata.mockRejectedValue(NOT_FOUND);
    client.setQueryData(queryKeys.clusterOverview("acme", ["lena-sandbox"]), {
      warnings: [
        {
          reason: "FailedGetResourceMetric",
          count: 29,
          older: null,
          lastSeen: null,
          sample: null,
          objectKind: "HorizontalPodAutoscaler",
          objectName: "hello-web",
          namespace: "lena-sandbox",
          incarnation: "gone",
          uid: "8b3e3d88",
        },
      ],
    });
    await waitFor(() => expect([...result.current]).toEqual([GONE]));
    expect(getObjectMetadata).toHaveBeenCalledTimes(2);
  });
});
