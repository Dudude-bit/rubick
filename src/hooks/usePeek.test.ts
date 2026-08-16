import { createElement, type ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { usePeek } from "./usePeek";

const at =
  (entry: string) =>
  ({ children }: { children: ReactNode }) =>
    createElement(MemoryRouter, { initialEntries: [entry] }, children);

/** The search string matters as much as the parsed target: it is the peek. */
const renderPeek = (entry = "/events") =>
  renderHook(() => ({ peek: usePeek(), search: useLocation().search }), {
    wrapper: at(entry),
  });

describe("usePeek", () => {
  it("starts closed", () => {
    const { result } = renderPeek();
    expect(result.current.peek.target).toBeNull();
  });

  it("round-trips a target through the query string", () => {
    const { result } = renderPeek();

    act(() =>
      result.current.peek.open({ kind: "Pod", name: "a-1", namespace: "ns" })
    );
    expect(new URLSearchParams(result.current.search).get("peek")).toBe(
      "pods/ns/a-1"
    );
    expect(result.current.peek.target).toEqual({
      kind: "Pod",
      name: "a-1",
      namespace: "ns",
    });

    act(() => result.current.peek.close());
    expect(result.current.peek.target).toBeNull();
  });

  it("reads a cluster-scoped target with no namespace", () => {
    const { result } = renderPeek("/events?peek=nodes/agent-0");
    expect(result.current.peek.target).toEqual({
      kind: "Node",
      name: "agent-0",
      namespace: null,
    });
  });

  it("accepts a kind spelled singular", () => {
    const { result } = renderPeek("/events?peek=Pod/ns/a-1");
    expect(result.current.peek.target?.kind).toBe("Pod");
  });

  /**
   * The half that used to be impossible. `open` was a no-op for a kind the
   * registry cannot spell, so an Argo Application — an object with more to
   * say about itself than most core kinds — could not be peeked at all.
   */
  describe("a custom resource", () => {
    it("round-trips through the CRD, the kind and the name", () => {
      const { result } = renderPeek();

      act(() =>
        result.current.peek.open({
          kind: "Application",
          name: "shop",
          namespace: "argocd",
          crd: "applications.argoproj.io",
        })
      );
      expect(new URLSearchParams(result.current.search).get("peek")).toBe(
        "applications.argoproj.io/Application/argocd/shop"
      );
      expect(result.current.peek.target).toEqual({
        kind: "Application",
        name: "shop",
        namespace: "argocd",
        crd: "applications.argoproj.io",
      });
    });

    it("reads a cluster-scoped one", () => {
      const { result } = renderPeek(
        "/events?peek=clusterissuers.cert-manager.io/ClusterIssuer/letsencrypt"
      );
      expect(result.current.peek.target).toEqual({
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
    it("is not confused with a core kind", () => {
      const { result } = renderPeek("/events?peek=pods/ns/a-1");
      expect(result.current.peek.target?.crd).toBeUndefined();
    });

    /** A name may contain dots; only the first segment is ever a CRD. */
    it("does not read a dotted object name as a CRD", () => {
      const { result } = renderPeek("/events?peek=secrets/ns/example.com-tls");
      expect(result.current.peek.target).toEqual({
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
  ])("ignores a malformed peek parameter (%s) instead of throwing", (raw) => {
    const { result } = renderPeek(`/events?peek=${raw}`);
    expect(result.current.peek.target).toBeNull();
  });

  // A nested click replaces the panel's contents. One parameter means browser
  // back steps through the peeks and then off them, with no stack to keep.
  it("overwrites the parameter rather than stacking a second one", () => {
    const { result } = renderPeek("/events?type=Warning");

    act(() =>
      result.current.peek.open({ kind: "Pod", name: "a-1", namespace: "ns" })
    );
    act(() =>
      result.current.peek.open({ kind: "Job", name: "b-2", namespace: "ns" })
    );

    const params = new URLSearchParams(result.current.search);
    expect(params.getAll("peek")).toEqual(["jobs/ns/b-2"]);
    expect(params.get("type")).toBe("Warning");
  });

  it("leaves the rest of the query behind when it closes", () => {
    const { result } = renderPeek("/events?type=Warning&peek=pods/ns/a-1");
    act(() => result.current.peek.close());
    expect(result.current.search).toBe("?type=Warning");
  });
});
