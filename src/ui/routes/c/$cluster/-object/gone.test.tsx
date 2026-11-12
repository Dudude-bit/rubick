import { describe, expect, it, vi } from "vite-plus/test";
import { screen } from "@testing-library/react";

vi.mock("@/lib/commands", () => ({ commands: {} }));

import { renderWithRouter } from "@/test/render";
import { GoneNotice } from "./gone";

const notice = (owners: Parameters<typeof GoneNotice>[0]["owners"]) =>
  renderWithRouter(
    <GoneNotice
      kind="Service"
      namespace="storefront"
      owners={owners}
      error='services "frontend" not found'
    />,
    { at: "/c/prod", route: "/c/$cluster" }
  );

describe("what is said of an object that is gone", () => {
  /**
   * Three things a last read can say about owners, and a sentence for each.
   * The one a Service's read gives, that it never looked, was worded as the
   * one a bare pod's gives. Fails if "not read" is drawn as "nothing owned
   * it", or as "never existed".
   */
  it("says nothing of owners where the last read did not carry them", async () => {
    await notice(null);
    expect(
      screen.getByText("This Service no longer exists.")
    ).toBeInTheDocument();
    expect(screen.queryByText(/Nothing owned it/)).toBeNull();
  });

  /** A read that looked and found none says so: nothing will put it back. */
  it("says nothing owned it where the last read named no owner", async () => {
    await notice([]);
    expect(
      screen.getByText("This Service no longer exists.")
    ).toBeInTheDocument();
    expect(
      screen.getByText("Nothing owned it, so nothing replaces it.")
    ).toBeInTheDocument();
  });

  /** With no read at all nothing says it ever existed. */
  it("does not call an object nobody read gone", async () => {
    await notice(undefined);
    expect(
      screen.getByText("This Service does not exist.")
    ).toBeInTheDocument();
    expect(screen.queryByText(/Nothing owned it/)).toBeNull();
  });
});
