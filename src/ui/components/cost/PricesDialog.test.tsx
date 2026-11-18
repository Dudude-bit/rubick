import { act, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vite-plus/test";

import { nameIsAnotherCluster } from "@/lib/kept-by-name";
import { useCostPricesStore } from "@/stores/costPricesStore";
import { renderWithRouter } from "@/test/render";
import { PricesDialog } from "./PricesDialog";
import { entryOf, named } from "@/lib/named";

/** A name to turn while the form draws, after its draft and before its effects. */
let turnWhileDrawing: string | null = null;
vi.mock("@/i18n/useT", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/i18n/useT")>();
  return {
    ...real,
    useT: () => {
      const t = real.useT();
      return ((section, key, values) => {
        if (key === "fieldCurrency" && turnWhileDrawing) {
          const name = turnWhileDrawing;
          turnWhileDrawing = null;
          nameIsAnotherCluster(name);
        }
        return t(section, key, values);
      }) as typeof t;
    },
  };
});

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

  /**
   * The name turned after the form drew its draft and before it subscribed:
   * the turn, told again as it subscribed, was taken for one before it
   * opened, and Save gave the old cluster's prices to the new one. Fails if
   * a draft drawn before such a turn survives it.
   */
  it("lets go of a draft drawn just before its name turned", async () => {
    useCostPricesStore.setState({
      prices: named({
        between: {
          cpu: 0.04,
          memory: 0.005,
          storage: null,
          gpu: null,
          currency: "EUR",
        },
      }),
    });
    turnWhileDrawing = "between";
    await renderWithRouter(
      <PricesDialog context="between" open onOpenChange={() => {}} />
    );
    expect(turnWhileDrawing).toBeNull();
    expect(screen.getByRole("textbox", { name: /CPU/ })).toHaveValue("");
  });

  /**
   * The dialog stayed open while its context changed: the form kept the
   * first cluster's draft, and Save wrote it under the second name. Fails
   * if a form outlives its context.
   */
  it("starts again from what is saved when its context changes", async () => {
    const prices = (cpu: number) => ({
      cpu,
      memory: 0.005,
      storage: null,
      gpu: null,
      currency: "EUR",
    });
    useCostPricesStore.setState({
      prices: named({ first: prices(0.04), second: prices(0.09) }),
    });
    const page = await renderWithRouter(
      <PricesDialog context="first" open onOpenChange={() => {}} />
    );
    expect(screen.getByRole("textbox", { name: /CPU/ })).toHaveValue("0.04");
    page.rerender(
      <PricesDialog context="second" open onOpenChange={() => {}} />
    );
    expect(screen.getByRole("textbox", { name: /CPU/ })).toHaveValue("0.09");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(entryOf(useCostPricesStore.getState().prices, "second")).toEqual(
      prices(0.09)
    );
  });
});
