import { describe, expect, it, vi } from "vite-plus/test";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

import type { Story } from "@/lib/event-stories";
import { queryKeys } from "@/lib/query-keys";
import { useClusterStore } from "@/stores/clusterStore";
import { useWindowActivity } from "@/lib/window-activity";
import { testQueryClient } from "@/test/render";

const getObjectMetadata = vi.hoisted(() => vi.fn());
const getClusterOverview = vi.hoisted(() => vi.fn());
vi.mock("@/lib/commands", () => ({
  commands: { getObjectMetadata, getClusterOverview },
}));

const { useGoneSubjects } = await import("./gone-subjects");
const { REFRESH_INTERVALS } = await import("@/lib/refresh");
const { useClusterOverview } = await import("@/hooks/useClusterOverview");

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

function mount(stories: Story[]) {
  const client = testQueryClient();
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const hook = renderHook(
    ({ told }: { told: Story[] }) => useGoneSubjects(told),
    { wrapper, initialProps: { told: stories } }
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
    const { result } = mount([
      story("hello-web"),
      story("refused"),
      story("api"),
      story("done-and-gone", "done"),
    ]);
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
    const { result } = mount([story("hello-web", "stillHappening")]);
    await waitFor(() => expect([...result.current]).toEqual([GONE]));
  });

  /**
   * An object deleted while its page stays open was read once, present, and
   * never again. Fails if the objects are not asked again at the steady
   * rate, are asked sooner, or are asked one question apiece rather than
   * as one.
   */
  it("asks again at the steady rate, all of them as one question", async () => {
    vi.useFakeTimers();
    try {
      useClusterStore.setState({ isConnected: true });
      useWindowActivity.setState({ visible: true, focused: true });
      getObjectMetadata.mockReset();
      getObjectMetadata.mockResolvedValue({ labels: {}, annotations: {} });
      const { client, result } = mount([
        story("hello-web", "stillHappening"),
        story("api", "stillHappening"),
      ]);
      await vi.advanceTimersByTimeAsync(10);
      expect(getObjectMetadata).toHaveBeenCalledTimes(2);
      expect(
        client.getQueryCache().findAll({ queryKey: ["held"] })
      ).toHaveLength(1);

      getObjectMetadata.mockImplementation(async (_kind, _version, name) => {
        if (name === "hello-web") throw NOT_FOUND;
        return { labels: {}, annotations: {} };
      });
      await vi.advanceTimersByTimeAsync(REFRESH_INTERVALS.steady / 2);
      expect(getObjectMetadata).toHaveBeenCalledTimes(2);

      await vi.advanceTimersByTimeAsync(REFRESH_INTERVALS.steady / 2 + 10);
      expect(getObjectMetadata).toHaveBeenCalledTimes(4);
      expect([...result.current]).toEqual([GONE]);
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * The stories follow the watch once a second, and an answer per story
   * redrew the page on each of them. Fails if an answer that changes no
   * story draws the reader of it again.
   */
  it("draws nothing for an answer that changes no story", async () => {
    useClusterStore.setState({ isConnected: true });
    getObjectMetadata.mockReset();
    getObjectMetadata.mockResolvedValue({ labels: {}, annotations: {} });
    let draws = 0;
    const client = testQueryClient();
    const told = [story("hello-web", "stillHappening")];
    renderHook(
      () => {
        draws += 1;
        return useGoneSubjects(told);
      },
      {
        wrapper: ({ children }: { children: ReactNode }) => (
          <QueryClientProvider client={client}>{children}</QueryClientProvider>
        ),
      }
    );
    await waitFor(() => expect(getObjectMetadata).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 5));
    const before = draws;

    await client.refetchQueries({ queryKey: ["held"] });
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(getObjectMetadata).toHaveBeenCalledTimes(2);
    expect(draws).toBe(before);
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
    const { client, result } = mount([story("hello-web", "stillHappening")]);
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
        },
      ],
    });
    await waitFor(() => expect([...result.current]).toEqual([GONE]));
    expect(getObjectMetadata).toHaveBeenCalledTimes(2);
  });

  /**
   * Dana's app.log held 33 "Missing queryFn" errors for the overview: this
   * page read its key with no fetcher, and a re-read the shell asked for
   * found none. Fails if reading the Overview's answer here leaves a re-read
   * of it without the fetcher the shell gave it.
   */
  it("reads the Overview's answer without taking its fetcher away", async () => {
    useClusterStore.setState({
      isConnected: true,
      currentContext: "acme",
      namespaceScope: ["lena-sandbox"],
    });
    getObjectMetadata.mockReset();
    getObjectMetadata.mockResolvedValue({ labels: {}, annotations: {} });
    getClusterOverview.mockReset();
    getClusterOverview.mockResolvedValue({ warnings: [] });
    const client = testQueryClient();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    const key = queryKeys.clusterOverview("acme", ["lena-sandbox"]);
    renderHook(
      () => {
        useClusterOverview(["lena-sandbox"]);
        return useGoneSubjects([story("hello-web")]);
      },
      { wrapper }
    );
    await waitFor(() => expect(getClusterOverview).toHaveBeenCalledTimes(1));

    await client.invalidateQueries({ queryKey: key });
    expect(client.getQueryState(key)?.error ?? null).toBeNull();
    expect(getClusterOverview).toHaveBeenCalledTimes(2);
  });
});
