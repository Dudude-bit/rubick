import { describe, expect, it, vi } from "vite-plus/test";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

import type { EventInfo } from "@/generated/types";
import { nameKey, namedOf } from "@/lib/event-incarnation";
import type { Story } from "@/lib/event-stories";
import { queryKeys } from "@/lib/query-keys";
import { useClusterStore } from "@/stores/clusterStore";
import { useWindowActivity } from "@/lib/window-activity";
import { testQueryClient } from "@/test/render";

const getObjectMetadata = vi.hoisted(() => vi.fn());
const getClusterOverview = vi.hoisted(() => vi.fn());
const nameHolder = vi.hoisted(() => vi.fn());
vi.mock("@/lib/commands", () => ({
  commands: { getObjectMetadata, getClusterOverview, nameHolder },
}));

const { useNameHolders } = await import("./name-holders");
const { REFRESH_INTERVALS } = await import("@/lib/refresh");
const { useClusterOverview } = await import("@/hooks/useClusterOverview");

const story = (name: string, state: Story["state"] = "settled") =>
  ({
    state,
    subject: {
      kind: "HorizontalPodAutoscaler",
      group: "autoscaling",
      name,
      namespace: "lena-sandbox",
      byName: false,
    },
  }) as Story;

const NOT_FOUND = { code: "NOT_FOUND", message: "not found" };
const GONE = "lena-sandbox/HorizontalPodAutoscaler.autoscaling/hello-web";
const there = (uid: string | null = "f0644886") => ({
  uid,
  labels: {},
  annotations: {},
});
const NO_EVENTS: EventInfo[] = [];
const nobody = (held: ReadonlyMap<string, string | null>) =>
  [...held].flatMap(([key, uid]) => (uid === null ? [key] : []));

function mount(stories: Story[], events: EventInfo[] = NO_EVENTS) {
  const client = testQueryClient();
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const hook = renderHook(
    ({ told }: { told: Story[] }) => useNameHolders(told, events),
    { wrapper, initialProps: { told: stories } }
  );
  return { client, ...hook };
}

describe("who holds the names the page speaks of", () => {
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
      return there("api-uid");
    });
    const { result } = mount([
      story("hello-web"),
      story("refused"),
      story("api"),
      story("done-and-gone", "done"),
    ]);
    await waitFor(() =>
      expect([...result.current]).toEqual([
        ["lena-sandbox/HorizontalPodAutoscaler.autoscaling/api", "api-uid"],
        [GONE, null],
      ])
    );
    expect(getObjectMetadata).toHaveBeenCalledTimes(3);
  });

  /**
   * etcd on a kind control plane: its events carry the hash in its mirror
   * annotation. Fails if a static pod is held by its mirror's uid, under
   * which every story of its own reads as an earlier object's.
   */
  it("holds a static pod by the uid its events carry", async () => {
    useClusterStore.setState({ isConnected: true });
    getObjectMetadata.mockReset();
    getObjectMetadata.mockResolvedValue({
      uid: "9f0c2a11",
      labels: {},
      annotations: { "kubernetes.io/config.mirror": "5f3c0d7e" },
    });
    const crashing = {
      state: "stillHappening",
      subject: {
        kind: "Pod",
        group: "",
        name: "etcd-cp",
        namespace: "kube-system",
        byName: false,
      },
    } as Story;
    const { result } = mount([crashing]);
    await waitFor(() =>
      expect([...result.current]).toEqual([
        ["kube-system/Pod/etcd-cp", "5f3c0d7e"],
      ])
    );
  });

  /**
   * An OpenKruise Advanced StatefulSet shares its Kind with the built-in one.
   * Asked at `apps/v1`, it is never found, and a live workload read as
   * deleted. Fails if a kind is asked by its bare name: in another group it
   * is asked where that group serves it, and where the events name no group
   * nobody can read it.
   */
  it("asks the built-in's address only for the built-in's own group", async () => {
    useClusterStore.setState({ isConnected: true });
    getObjectMetadata.mockReset();
    getObjectMetadata.mockRejectedValue(NOT_FOUND);
    nameHolder.mockReset();
    nameHolder.mockResolvedValue({ held: "by", uid: "k1" });
    const set = (name: string, group: string | null) =>
      ({
        state: "stillHappening",
        subject: {
          kind: "StatefulSet",
          group,
          name,
          namespace: "shop",
          byName: false,
        },
      }) as Story;
    const { result } = mount([
      set("kruise", "apps.kruise.io"),
      set("unsaid", null),
      set("own", "apps"),
    ]);
    await waitFor(() =>
      expect(nobody(result.current)).toEqual(["shop/StatefulSet.apps/own"])
    );
    expect(getObjectMetadata.mock.calls).toEqual([
      ["StatefulSet", "apps/v1", "own", "shop"],
    ]);
    expect(nameHolder.mock.calls).toEqual([
      ["apps.kruise.io", "StatefulSet", "kruise", "shop"],
    ]);
  });

  /**
   * The Overview read a deleted Knative Service through discovery and called
   * it deleted, while its story and rows here linked to it as an object still
   * there: a custom kind was asked of nobody. Fails if a custom kind's name
   * is not asked where its group serves it, or if a read that could not say,
   * refused or failed, is taken for nobody holding the name.
   */
  it("asks who holds a custom kind's name through the cluster's discovery", async () => {
    useClusterStore.setState({ isConnected: true });
    getObjectMetadata.mockReset();
    nameHolder.mockReset();
    nameHolder.mockImplementation(async (_group, _kind, name) => {
      if (name === "gone") return { held: "nobody" };
      if (name === "blind") return { held: "notRead" };
      if (name === "broken") throw { code: "KUBE_API_ERROR", message: "boom" };
      return { held: "by", uid: "k1" };
    });
    const knative = (name: string) =>
      ({
        state: "stillHappening",
        subject: {
          kind: "Service",
          group: "serving.knative.dev",
          name,
          namespace: "shop",
          byName: false,
        },
      }) as Story;
    const { result } = mount(["web", "gone", "blind", "broken"].map(knative));
    await waitFor(() =>
      expect([...result.current]).toEqual([
        ["shop/Service.serving.knative.dev/gone", null],
        ["shop/Service.serving.knative.dev/web", "k1"],
      ])
    );
    expect(nameHolder.mock.calls).toContainEqual([
      "serving.knative.dev",
      "Service",
      "gone",
      "shop",
    ]);
    expect(nameHolder).toHaveBeenCalledTimes(4);
    expect(getObjectMetadata).not.toHaveBeenCalled();
  });

  /**
   * A node the autoscaler removed: its kubelet's warnings name no
   * `apiVersion`, so nobody was asked and their card stayed "still
   * happening" beside a link to a page that answers not found. Fails if the
   * kubelet's Node warning is not asked at the Node's own address, or the
   * answer is not held under the key its rows and its story read.
   */
  it("asks who holds a Node whose kubelet warned with no apiVersion", async () => {
    useClusterStore.setState({ isConnected: true });
    getObjectMetadata.mockReset();
    getObjectMetadata.mockRejectedValue(NOT_FOUND);
    nameHolder.mockReset();
    const kubelet: EventInfo = {
      name: "n1.17f",
      namespace: "default",
      uid: "e1",
      type: "Warning",
      reason: "EvictionThresholdMet",
      message: null,
      source: "kubelet",
      involvedObject: {
        kind: "Node",
        name: "n1",
        namespace: null,
        uid: "n1",
      },
      count: 1,
      firstTimestamp: null,
      lastTimestamp: null,
    };
    const { result } = mount([], [kubelet]);
    await waitFor(() =>
      expect([...result.current]).toEqual([["default/Node/n1", null]])
    );
    expect(result.current.has(nameKey(namedOf(kubelet)))).toBe(true);
    expect(getObjectMetadata.mock.calls).toEqual([
      ["Node", "v1", "n1", "default"],
    ]);
    expect(nameHolder).not.toHaveBeenCalled();
  });

  /**
   * Lena's two HPAs named hello-web, both deleted: the list view asked
   * nothing, and the first one's chip said another HPA held the name. Fails
   * if a name the events give two objects for is not asked with no story
   * asking for it.
   */
  it("asks who holds a name several objects have had, with no story asking", async () => {
    useClusterStore.setState({ isConnected: true });
    getObjectMetadata.mockReset();
    getObjectMetadata.mockRejectedValue(NOT_FOUND);
    const said = (uid: string): EventInfo => ({
      name: `hello-web.${uid}`,
      namespace: "lena-sandbox",
      uid: `event-${uid}`,
      type: "Normal",
      reason: "SuccessfulRescale",
      message: null,
      source: null,
      involvedObject: {
        apiVersion: "autoscaling/v2",
        kind: "HorizontalPodAutoscaler",
        name: "hello-web",
        namespace: "lena-sandbox",
        uid,
      },
      count: 1,
      firstTimestamp: null,
      lastTimestamp: null,
    });
    const { result } = mount([], [said("caeffa0e"), said("f0644886")]);
    await waitFor(() => expect(nobody(result.current)).toEqual([GONE]));
    expect(getObjectMetadata).toHaveBeenCalledTimes(1);
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
    await waitFor(() => expect(nobody(result.current)).toEqual([GONE]));
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
      getObjectMetadata.mockResolvedValue(there());
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
        return there();
      });
      await vi.advanceTimersByTimeAsync(REFRESH_INTERVALS.steady / 2);
      expect(getObjectMetadata).toHaveBeenCalledTimes(2);

      await vi.advanceTimersByTimeAsync(REFRESH_INTERVALS.steady / 2 + 10);
      expect(getObjectMetadata).toHaveBeenCalledTimes(4);
      expect(nobody(result.current)).toEqual([GONE]);
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
    getObjectMetadata.mockResolvedValue(there());
    let draws = 0;
    const client = testQueryClient();
    const told = [story("hello-web", "stillHappening")];
    renderHook(
      () => {
        draws += 1;
        return useNameHolders(told, NO_EVENTS);
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
    getObjectMetadata.mockResolvedValue(there());
    const { client, result } = mount([story("hello-web", "stillHappening")]);
    await waitFor(() => expect(getObjectMetadata).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(nobody(result.current)).toEqual([]);

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
          objectApiVersion: "autoscaling/v2",
          objectName: "hello-web",
          namespace: "lena-sandbox",
          incarnation: "gone",
          uid: "8b3e3d88",
        },
      ],
    });
    await waitFor(() => expect(nobody(result.current)).toEqual([GONE]));
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
    getObjectMetadata.mockResolvedValue(there());
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
        return useNameHolders([story("hello-web")], NO_EVENTS);
      },
      { wrapper }
    );
    await waitFor(() => expect(getClusterOverview).toHaveBeenCalledTimes(1));

    await client.invalidateQueries({ queryKey: key });
    expect(client.getQueryState(key)?.error ?? null).toBeNull();
    expect(getClusterOverview).toHaveBeenCalledTimes(2);
  });
});
