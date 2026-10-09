// @vitest-environment jsdom
import { createElement } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { act } from "@testing-library/react";

import { renderWithRouter } from "@/test/render";
import { peekTargetOfHref, usePeek } from "./usePeek";

/** The search string matters as much as the parsed target: it is the peek. */
async function renderPeek(entry = "/c/prod/events") {
  const result = {} as { current: ReturnType<typeof usePeek> };
  function Probe() {
    result.current = usePeek();
    return null;
  }
  const { router } = await renderWithRouter(createElement(Probe), {
    at: entry,
    route: "/c/$cluster/events",
  });
  const search = () => router.state.location.search as Record<string, unknown>;
  return { result, search };
}

describe("usePeek", () => {
  it("starts closed", async () => {
    const { result } = await renderPeek();
    expect(result.current.target).toBeNull();
  });

  it("round-trips a target through the query string", async () => {
    const { result, search } = await renderPeek();

    act(() =>
      result.current.open({ kind: "Pod", name: "a-1", namespace: "ns" })
    );
    await vi.waitFor(() => expect(search().peek).toBe("pods/ns/a-1"));
    await vi.waitFor(() =>
      expect(result.current.target).toEqual({
        kind: "Pod",
        name: "a-1",
        namespace: "ns",
      })
    );

    act(() => result.current.close());
    await vi.waitFor(() => expect(result.current.target).toBeNull());
  });

  it("reads a cluster-scoped target with no namespace", async () => {
    const { result } = await renderPeek("/c/prod/events?peek=nodes/agent-0");
    expect(result.current.target).toEqual({
      kind: "Node",
      name: "agent-0",
      namespace: null,
    });
  });

  it("accepts a kind spelled singular", async () => {
    const { result } = await renderPeek("/c/prod/events?peek=Pod/ns/a-1");
    expect(result.current.target?.kind).toBe("Pod");
  });

  /**
   * The half that used to be impossible. `open` was a no-op for a kind the
   * registry cannot spell, so an Argo Application — an object with more to
   * say about itself than most core kinds — could not be peeked at all.
   */
  describe("a custom resource", () => {
    it("round-trips through the CRD, the kind and the name", async () => {
      const { result, search } = await renderPeek();

      act(() =>
        result.current.open({
          kind: "Application",
          name: "shop",
          namespace: "argocd",
          crd: "applications.argoproj.io",
        })
      );
      await vi.waitFor(() =>
        expect(search().peek).toBe(
          "applications.argoproj.io/Application/argocd/shop"
        )
      );
      await vi.waitFor(() =>
        expect(result.current.target).toEqual({
          kind: "Application",
          name: "shop",
          namespace: "argocd",
          crd: "applications.argoproj.io",
        })
      );
    });

    it("reads a cluster-scoped one", async () => {
      const { result } = await renderPeek(
        "/c/prod/events?peek=clusterissuers.cert-manager.io/ClusterIssuer/letsencrypt"
      );
      expect(result.current.target).toEqual({
        kind: "ClusterIssuer",
        name: "letsencrypt",
        namespace: null,
        crd: "clusterissuers.cert-manager.io",
      });
    });

    /**
     * The dot is the whole disambiguation, and it holds because a CRD is
     * always `<plural>.<group>` and no plural in the registry has one.
     */
    it("is not confused with a core kind", async () => {
      const { result } = await renderPeek("/c/prod/events?peek=pods/ns/a-1");
      expect(result.current.target?.crd).toBeUndefined();
    });

    /** A core kind outside the registry is served at a bare plural, with no dot to find. */
    it("reads a core kind the registry does not hold by its bare plural", async () => {
      const { result } = await renderPeek(
        "/c/prod/events?peek=serviceaccounts/ServiceAccount/checkout/marco"
      );
      expect(result.current.target).toEqual({
        kind: "ServiceAccount",
        name: "marco",
        namespace: "checkout",
        crd: "serviceaccounts",
      });
    });

    /** A name may contain dots; only the first segment is ever a CRD. */
    it("does not read a dotted object name as a CRD", async () => {
      const { result } = await renderPeek(
        "/c/prod/events?peek=secrets/ns/example.com-tls"
      );
      expect(result.current.target).toEqual({
        kind: "Secret",
        name: "example.com-tls",
        namespace: "ns",
      });
    });
  });

  it.each([
    "nonsense",
    "frobnicators/ns/a-1",
    "pods/",
    "pods/a/b/c",
    // A CRD shape truncated to `<crd>/<ns>/<name>`: the namespace would be
    // read as the kind and a panel headed `argocd` is worse than none.
    "applications.argoproj.io/argocd/shop",
    "applications.argoproj.io/Application",
  ])(
    "ignores a malformed peek parameter (%s) instead of throwing",
    async (raw) => {
      const { result } = await renderPeek(`/c/prod/events?peek=${raw}`);
      expect(result.current.target).toBeNull();
    }
  );

  // A nested click replaces the panel's contents. One parameter means browser
  // back steps through the peeks and then off them, with no stack to keep.
  it("overwrites the parameter rather than stacking a second one", async () => {
    const { result, search } = await renderPeek("/c/prod/events?q=warn");

    act(() =>
      result.current.open({ kind: "Pod", name: "a-1", namespace: "ns" })
    );
    await vi.waitFor(() => expect(search().peek).toBe("pods/ns/a-1"));
    act(() =>
      result.current.open({ kind: "Job", name: "b-2", namespace: "ns" })
    );

    await vi.waitFor(() =>
      expect(search()).toEqual({ q: "warn", peek: "jobs/ns/b-2" })
    );
  });

  it("leaves the rest of the query behind when it closes", async () => {
    const { result, search } = await renderPeek(
      "/c/prod/events?q=warn&peek=pods/ns/a-1"
    );
    act(() => result.current.close());
    await vi.waitFor(() => expect(search()).toEqual({ q: "warn" }));
  });
});

describe("peekTargetOfHref", () => {
  /** A row's route is the peek's value with a slash in front; anything else has no peek. */
  it("reads a core route and refuses every other shape", () => {
    expect(peekTargetOfHref("/c/prod/pods/default/nginx")).toEqual({
      kind: "Pod",
      name: "nginx",
      namespace: "default",
    });
    expect(peekTargetOfHref("/c/prod/nodes/k3d-agent-0?tab=pods")).toEqual({
      kind: "Node",
      name: "k3d-agent-0",
      namespace: null,
    });
    expect(peekTargetOfHref("/c/prod/helm/native/default/release")).toBeNull();
    expect(
      peekTargetOfHref("/c/prod/applications.argoproj.io/argocd/shop")
    ).toBeNull();
    expect(peekTargetOfHref("/pods/default/nginx")).toBeNull();
  });
});
