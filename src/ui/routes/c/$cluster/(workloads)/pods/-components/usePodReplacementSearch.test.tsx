import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { act, renderHook } from "@testing-library/react";

const commands = vi.hoisted(() => ({ listPods: vi.fn() }));
vi.mock("@/lib/commands", () => ({ commands }));

import type { PodInfo } from "@/generated/types";
import {
  replacementAmong,
  replacementSelector,
  usePodReplacementSearch,
} from "./usePodReplacementSearch";

const pod = (name: string, over: object = {}) =>
  ({
    name,
    namespace: "shop",
    labels: { app: "cart", "pod-template-hash": "7f9c" },
    createdAt: "2026-11-12T10:00:00Z",
    status: { display: "Running" },
    ...over,
  }) as unknown as PodInfo;

beforeEach(() => vi.resetAllMocks());

describe("what a pod's replacement is looked for by", () => {
  /**
   * A rollout is how most pods go, and its new pods carry another
   * pod-template-hash. With the hash in the selector the list was empty, and
   * the page said no running pod matched beside a Deployment whose new pods
   * were all Running. Fails if the selector names the ReplicaSet of a pod
   * that also says which workload it is of.
   */
  it("is the workload's labels, without the ReplicaSet's hash", () => {
    expect(
      replacementSelector({
        app: "cart",
        "app.kubernetes.io/instance": "shop",
        "pod-template-hash": "7f9c",
        tier: "web",
      })
    ).toBe("app=cart,app.kubernetes.io/instance=shop");
  });

  /** The hash is still better than nothing. Fails if a pod that carries only it is not searched for at all. */
  it("is the hash alone for a pod that says nothing else", () => {
    expect(replacementSelector({ "pod-template-hash": "7f9c" })).toBe(
      "pod-template-hash=7f9c"
    );
    expect(replacementSelector({ tier: "web" })).toBeNull();
  });
});

describe("the pod a reader is sent to", () => {
  /**
   * Mid-rollout the list holds the old ReplicaSet's pods and the new one's.
   * Fails if the reader is sent to an older pod, the pod that went, or one
   * that is not running.
   */
  it("is the newest one running, and never the one that went", () => {
    const found = replacementAmong(
      [
        pod("cart-old", { createdAt: "2026-11-12T09:00:00Z" }),
        pod("cart-gone", { createdAt: "2026-11-12T11:00:00Z" }),
        pod("cart-new", { createdAt: "2026-11-12T10:30:00Z" }),
        pod("cart-crashing", {
          createdAt: "2026-11-12T10:45:00Z",
          status: { display: "CrashLoopBackOff" },
        }),
      ],
      "cart-gone"
    );
    expect(found?.name).toBe("cart-new");
    expect(replacementAmong([pod("cart-gone")], "cart-gone")).toBeNull();
  });
});

describe("looking for a replacement", () => {
  // One object, as a query hands the page: the hook keeps the labels of
  // whichever pod it was last given.
  const gone = pod("cart-gone");
  const search = () =>
    renderHook(() => usePodReplacementSearch(gone, "cart-gone", "shop"));
  const find = async (hook: ReturnType<typeof search>) => {
    let answer!: Awaited<
      ReturnType<typeof hook.result.current.findReplacement>
    >;
    await act(async () => {
      answer = await hook.result.current.findReplacement();
    });
    return answer;
  };

  /**
   * A reader may get a pod by name and be refused the list of its
   * namespace. The refusal came back as "no pod", and the page said no
   * other running pod matched. Fails if a list that could not be read
   * answers the same as one that came back empty.
   */
  it("says it could not look when the list is refused, never that there is none", async () => {
    const refused = { code: "PERMISSION_DENIED", message: "pods is forbidden" };
    commands.listPods.mockRejectedValue(refused);

    expect(await find(search())).toEqual({ is: "unread", error: refused });
  });

  /** The other two answers, so that "unread" is not the only one a list can give. */
  it("says none for a list that answered with no other running pod, and names the one it found", async () => {
    commands.listPods.mockResolvedValue([pod("cart-gone")]);
    expect(await find(search())).toEqual({ is: "none" });

    commands.listPods.mockResolvedValue([pod("cart-gone"), pod("cart-new")]);
    expect(await find(search())).toMatchObject({
      is: "found",
      pod: { name: "cart-new" },
    });
    expect(commands.listPods).toHaveBeenLastCalledWith(
      expect.objectContaining({ namespace: "shop", labelSelector: "app=cart" })
    );
  });
});
