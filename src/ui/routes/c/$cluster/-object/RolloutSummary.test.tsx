import { afterEach, describe, expect, it } from "vite-plus/test";
import { screen } from "@testing-library/react";

import type { Rollout } from "@/generated/types";
import { useLocaleStore } from "@/stores/localeStore";
import { renderWithRouter } from "@/test/render";
import { RolloutBadge, RolloutSummary } from "./RolloutSummary";

const stalled: Rollout = {
  state: "stalled",
  message: 'ReplicaSet "web-7f9" has timed out progressing.',
  serving: 1,
};

describe("the rollout line beside the controller's own words", () => {
  afterEach(() => useLocaleStore.setState({ choice: null }));

  /**
   * The controller's English sentence followed a Russian one with nothing
   * to say whose words they were, and read as the app's own.
   */
  it("says the quoted sentence is the controller's, in the reader's language", async () => {
    useLocaleStore.setState({ choice: "ru" });
    await renderWithRouter(
      <RolloutSummary
        rollout={stalled}
        subject={{ kind: "Deployment", name: "web", namespace: "shop" }}
      />
    );
    const line = screen.getByTestId("rollout-summary");
    expect(line).toHaveTextContent(
      /Сообщение контроллера: ReplicaSet .*web-7f9.* has timed out progressing\./
    );
  });
});

describe("the rollout badge on hover", () => {
  afterEach(() => useLocaleStore.setState({ choice: null }));

  /** A Ready Deployment's badge had no tooltip at all, while a Pod's Running said what it meant. */
  it("says what Ready means when there is no rollout sentence to show", async () => {
    useLocaleStore.setState({ choice: "ru" });
    await renderWithRouter(<RolloutBadge rollout={{ state: "ready" }} />);
    expect(screen.getByText("Готов")).toHaveAttribute(
      "title",
      "Готов: все нужные реплики запущены и доступны."
    );
  });
});
