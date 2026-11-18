import { act, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vite-plus/test";

import { nameIsAnotherCluster } from "@/lib/kept-by-name";
import { useCostPricesStore } from "@/stores/costPricesStore";
import { renderWithRouter } from "@/test/render";
import { PricesDialog } from "./PricesDialog";
import { entryOf, named } from "@/lib/named";

describe("the prices dialog", () => {
  /**
   * The name turned into another cluster while the form was open: its
   * fields still held the old cluster's prices, and Save wrote them for the
   * new one. Fails if a form open across the turn can save what it held.
   */
  it("lets go of what it holds when its name turns into another cluster", async () => {
    useCostPricesStore.setState({
      prices: named({
        turning: {
          cpu: 0.04,
          memory: 0.005,
          storage: null,
          gpu: null,
          currency: "EUR",
        },
      }),
    });
    await renderWithRouter(
      <PricesDialog context="turning" open onOpenChange={() => {}} />
    );
    const cpu = screen.getByRole("textbox", { name: /CPU/ });
    expect(cpu).toHaveValue("0.04");

    act(() => nameIsAnotherCluster("turning"));
    expect(cpu).toHaveValue("");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(
      entryOf(useCostPricesStore.getState().prices, "turning")
    ).toBeUndefined();
  });

  /**
   * The name had turned earlier this session and the new cluster's prices
   * were saved since: opening the form must show them. Fails if the turn,
   * told again as the form subscribes, empties a form drawn from them.
   */
  it("opens on the new cluster's prices after its name turned earlier", async () => {
    nameIsAnotherCluster("turned-before");
    useCostPricesStore.setState({
      prices: named({
        "turned-before": {
          cpu: 0.07,
          memory: 0.005,
          storage: null,
          gpu: null,
          currency: "EUR",
        },
      }),
    });
    await renderWithRouter(
      <PricesDialog context="turned-before" open onOpenChange={() => {}} />
    );
    const cpu = screen.getByRole("textbox", { name: /CPU/ });
    expect(cpu).toHaveValue("0.07");

    act(() => nameIsAnotherCluster("turned-before"));
    expect(cpu).toHaveValue("");
  });
});
