import { render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vite-plus/test";

import type { NodeBudget } from "@/generated/types";
import { translate } from "@/i18n";
import { useLocaleStore } from "@/stores/localeStore";
import { NodeResources } from "./NodeResources";

function budget(cpu: Partial<NodeBudget["resources"][number]>): NodeBudget {
  return {
    pods: 42,
    known: true,
    refused: [],
    error: null,
    resources: [
      {
        name: "cpu",
        unit: "cpu",
        capacity: 1000,
        allocatable: 1000,
        requested: 465,
        limited: 1200,
        extended: false,
        ...cpu,
      },
    ],
  };
}

function cpuRow() {
  render(
    <NodeResources
      budget={budget({})}
      error={null}
      onRetry={() => {}}
      usage={null}
    />
  );
  return screen.getByRole("row", { name: /^cpu/ });
}

afterEach(() => useLocaleStore.setState({ choice: "en" }));

describe("the node's CPU row", () => {
  /**
   * Lena read "1,0 · 1,0 · 465m · 1,2" in one row. Fails if a row that has
   * a whole core in it prints any other cell in millicores.
   */
  it("reads every cell in cores once one of them is a whole core", () => {
    useLocaleStore.setState({ choice: "ru" });
    const cells = within(cpuRow())
      .getAllByRole("cell")
      .map((cell) => cell.textContent);
    expect(cells).toEqual([
      "cpu",
      "1",
      "1",
      "0,465" + "47%",
      "1,2" + "120%",
      expect.stringMatching(/./),
    ]);
  });

  /** A node with under a core everywhere keeps millicores, as kubectl prints it. */
  it("keeps millicores where nothing reaches a core", () => {
    render(
      <NodeResources
        budget={budget({ capacity: 900, allocatable: 800, limited: 600 })}
        error={null}
        onRetry={() => {}}
        usage={null}
      />
    );
    expect(screen.getByRole("row", { name: /^cpu/ }).textContent).toContain(
      "465m"
    );
  });
});

describe("the node's requested formula in Russian", () => {
  /** The footer put an English formula in a Russian sentence; fails if it comes back. */
  it("is written in words, with no English formula in it", () => {
    const text = translate("ru", "empty", "nodeBudgetRule", { n: 42 });
    expect(text).not.toMatch(/max\(|Σ|before it/);
    expect(text).toContain("по 42 подам");
  });
});
