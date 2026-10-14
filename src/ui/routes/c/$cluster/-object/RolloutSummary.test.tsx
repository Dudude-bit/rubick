import { afterEach, describe, expect, it } from "vite-plus/test";
import { screen, waitFor, within } from "@testing-library/react";

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

describe("a verdict that arrives while the page is open", () => {
  const subject = { kind: "Deployment", name: "web", namespace: "shop" };
  const unavailable: Rollout = {
    state: "unavailable",
    reason: "MinimumReplicasUnavailable",
    message: "Deployment does not have minimum availability.",
    available: 0,
    desired: 1,
  };
  const page = (rollout: Rollout) => (
    <>
      <div data-testid="header-row">
        <RolloutSummary rollout={rollout} subject={subject} place="header" />
      </div>
      <div data-testid="above-strip">
        <RolloutSummary rollout={rollout} subject={subject} place="line" />
      </div>
    </>
  );

  /**
   * A drain's Unavailable lasted 0.3 s and came as a line above the strip
   * that pushed the page down and back. Fails if a fresh verdict takes that
   * line at once, never takes it, or is not said in the header meanwhile.
   */
  it("waits in the header row until it has lasted", async () => {
    const { rerender } = await renderWithRouter(page({ state: "ready" }));
    await rerender(page(unavailable));
    expect(
      within(screen.getByTestId("header-row")).getByTestId("rollout-summary")
    ).toHaveTextContent("MinimumReplicasUnavailable");
    expect(
      within(screen.getByTestId("above-strip")).queryByTestId("rollout-summary")
    ).toBeNull();
    await waitFor(
      () =>
        expect(
          within(screen.getByTestId("above-strip")).getByTestId(
            "rollout-summary"
          )
        ).toHaveTextContent("Deployment does not have minimum availability."),
      { timeout: 2000 }
    );
    expect(
      within(screen.getByTestId("header-row")).queryByTestId("rollout-summary")
    ).toBeNull();
  });

  /** Fails if a page opened on a standing outage holds its line back. */
  it("takes its line at once when it stood before the page opened", async () => {
    await renderWithRouter(page(unavailable));
    expect(
      within(screen.getByTestId("above-strip")).getByTestId("rollout-summary")
    ).toHaveTextContent("MinimumReplicasUnavailable");
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
