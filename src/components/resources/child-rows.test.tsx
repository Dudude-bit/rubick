import { afterEach, describe, expect, it } from "vitest";

import type { JobInfo, ReplicaSetInfo } from "@/generated/types";
import { useLocaleStore } from "@/stores/localeStore";
import { renderWithProviders } from "@/test/render";
import { JobRows, RevisionRows } from "./child-rows";

const revision = (
  name: string,
  revision: string,
  desired: number,
  ready: number
): ReplicaSetInfo =>
  ({
    name,
    namespace: "default",
    revision,
    currentRevision: "4",
    replicas: { desired, ready, current: ready, available: ready },
    createdAt: null,
  }) as unknown as ReplicaSetInfo;

const job: JobInfo = {
  name: "nightly-1",
  namespace: "default",
  completions: 1,
  succeeded: 0,
  failed: 2,
  active: 0,
  status: "Failed",
  createdAt: null,
};

describe("the rows a workload's own objects get, in the reader's language", () => {
  afterEach(() => useLocaleStore.setState({ choice: null }));

  /**
   * Beside the pod rows, the revision and Job rows glued English words
   * to their counts: "revision 4 · 2/3 ready", "scaled to zero",
   * "0/1 completed · 2 failed".
   */
  it("says a revision's number and readiness in Russian", () => {
    useLocaleStore.setState({ choice: "ru" });
    const { container } = renderWithProviders(
      <RevisionRows
        revisions={[revision("web-4", "4", 3, 2), revision("web-3", "3", 0, 0)]}
      />,
      { initialEntries: ["/"] }
    );
    expect(container.textContent).toContain("ревизия 4 · готово 2/3");
    expect(container.textContent).toContain(
      "ревизия 3 · масштабирован до нуля"
    );
    expect(container.textContent).not.toMatch(/revision|ready|scaled/);
  });

  /** Would break if the Job row's counts went back to English words. */
  it("says a Job's completions and failures in Russian", () => {
    useLocaleStore.setState({ choice: "ru" });
    const { container } = renderWithProviders(<JobRows jobs={[job]} />, {
      initialEntries: ["/"],
    });
    expect(container.textContent).toContain("завершено 0/1 · 2 неудачных");
    expect(container.textContent).not.toMatch(/completed|failed/);
  });
});
