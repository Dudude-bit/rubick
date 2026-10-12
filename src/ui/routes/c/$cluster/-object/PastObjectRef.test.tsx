import { describe, expect, it } from "vite-plus/test";
import { screen } from "@testing-library/react";

import { renderWithRouter } from "@/test/render";
import { PastObjectRef } from "./PastObjectRef";

describe("a name that is not the object there now", () => {
  /**
   * The Events list at 1024 in Russian cut wd-demo to "wd·" beside the
   * "прежний объект" mark. Fails if the mark's word takes the name's room in
   * a narrow cell, or stops being said to a screen reader there.
   */
  it("gives a narrow cell's room to the name and keeps the mark's word for wider ones", async () => {
    const { container } = await renderWithRouter(
      <PastObjectRef kind="Pod" name="wd-demo" past="earlier" fit />
    );
    const word = screen.getByText("earlier object");
    expect(word).toHaveClass("sr-only", "@[15rem]:not-sr-only");
    expect(container.querySelector("[data-past='earlier']")).toHaveClass(
      "@container",
      "w-full"
    );
  });

  /** A story card's header has the room; fails if the word is hidden where nothing asked. */
  it("says the mark's word in full where it is not fitted to a cell", async () => {
    await renderWithRouter(
      <PastObjectRef kind="Pod" name="wd-demo" past="earlier" />
    );
    expect(screen.getByText("earlier object")).not.toHaveClass("sr-only");
  });
});
