import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { renderHook, screen } from "@testing-library/react";

import type { Attention, AttentionItem } from "@/lib/attention";
import type { Finding } from "@/lib/governance";
import { useClusterStore } from "@/stores/clusterStore";
import { renderWithRouter } from "@/test/render";

const attention = vi.hoisted(() => ({
  answer: null as Attention | null,
  asked: [] as (readonly string[] | undefined)[],
}));

vi.mock("@/hooks/useAttention", () => ({
  useAttention: ({ scope }: { scope?: readonly string[] }) => {
    attention.asked.push(scope);
    return attention.answer;
  },
}));

import { PodsTroubleLines } from "./PodsTrouble";
import { usePodsTrouble, withPodsTrouble } from "./pods-trouble";

const failing = (name: string): AttentionItem =>
  ({
    key: name,
    tone: "warn",
    kind: "Pod",
    name,
    namespace: "argocd",
    reason: "Unhealthy",
    detail: {
      says: "probe",
      failure: {
        container: "repo-server",
        probe: "liveness",
        restarts: 1,
        said: "Liveness probe failed: context deadline exceeded",
        since: null,
      },
    },
    since: null,
    restarts: 1,
    foldedPods: null,
    replaced: false,
    workload: { kind: "Deployment", name: "argocd-repo-server" },
    opens: { kind: "Pod", name, namespace: "argocd" },
  }) as AttentionItem;

const scaler = {
  ...failing("argocd-repo-server"),
  key: "hpa",
  kind: "HorizontalPodAutoscaler",
  reason: "FailedGetScale",
  detail: null,
  workload: undefined,
  opens: {
    kind: "Deployment",
    name: "argocd-repo-server",
    namespace: "argocd",
  },
} as AttentionItem;

const pods = [failing("repo-server-mpmgs"), failing("repo-server-khl75")];

beforeEach(() => {
  attention.answer = null;
  attention.asked = [];
  useClusterStore.setState({ namespaceScope: [] });
});

/**
 * The Deployment's page said "Ready 2/2" in green with nothing above its
 * tabs while both its pods failed their liveness probe. Fails if the page
 * stops naming how many pods fail what, or stops linking to them.
 */
describe("a workload page's line about its failing pods", () => {
  it("says how many of its pods fail what, and links each one", async () => {
    await renderWithRouter(<PodsTroubleLines pods={pods} />);
    expect(screen.getByText("2 of its pods are Unhealthy")).toBeInTheDocument();
    for (const { name } of pods)
      expect(screen.getByText(name).closest("a")).toHaveAttribute(
        "href",
        `/c/test/pods/argocd/${name}`
      );
  });

  it("draws nothing while the answer is not in, or where no pod fails", async () => {
    const { container } = await renderWithRouter(
      <>
        <PodsTroubleLines pods={null} />
        <PodsTroubleLines pods={[]} />
      </>
    );
    expect(container.querySelector("[data-testid='pods-trouble']")).toBeNull();
  });
});

/**
 * The page chip must count what the list row counts. Fails if the pods'
 * rows are dropped from it, or replace the page's own findings.
 */
describe("the page chip with its pods' problems", () => {
  const scaling: Finding = {
    tone: "err",
    title: "the autoscaler cannot read its scale",
    detail: "",
  };

  it("adds its pods' rows to its own findings, the loudest tone leading", () => {
    expect(withPodsTrouble([], pods)).toMatchObject({ tone: "warn", n: 2 });
    expect(withPodsTrouble([scaling], pods)).toEqual({
      tone: "err",
      n: 3,
      title: "the autoscaler cannot read its scale",
    });
  });

  it("leaves the chip to the page where no pod fails, or the answer is not in", () => {
    expect(withPodsTrouble([scaling], [])).toBeUndefined();
    expect(withPodsTrouble([scaling], null)).toBeUndefined();
  });
});

/**
 * Fails if the page reads its pods' rows only where the window's scope
 * happens to hold its namespace, or claims none before the answer is in.
 */
describe("which pods' rows a workload page reads", () => {
  it("is unknown until the shell answers, then only its own pods' rows", () => {
    const { result, rerender } = renderHook(() =>
      usePodsTrouble("Deployment", "argocd", "argocd-repo-server")
    );
    expect(result.current).toBeNull();
    attention.answer = { items: [...pods, scaler] } as Attention;
    rerender();
    expect(result.current?.map(({ key }) => key)).toEqual(
      pods.map(({ key }) => key)
    );
  });

  it("asks for its own namespace where the window's scope leaves it out", () => {
    useClusterStore.setState({ namespaceScope: ["default"] });
    renderHook(() =>
      usePodsTrouble("Deployment", "argocd", "argocd-repo-server")
    );
    expect(attention.asked.at(-1)).toEqual(["argocd"]);
    useClusterStore.setState({ namespaceScope: ["argocd", "default"] });
    renderHook(() =>
      usePodsTrouble("Deployment", "argocd", "argocd-repo-server")
    );
    expect(attention.asked.at(-1)).toBeUndefined();
  });
});
