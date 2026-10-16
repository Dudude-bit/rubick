import { beforeEach, describe, expect, it } from "vite-plus/test";
import { screen } from "@testing-library/react";

import { renderWithRouter } from "@/test/render";
import { useDisplaySettingsStore } from "@/stores/displaySettingsStore";
import { usePeekDock } from "./peek-dock";

function Page() {
  return <div data-testid="page" style={usePeekDock()} />;
}

const page = () => screen.getByTestId("page");

beforeEach(() => {
  useDisplaySettingsStore.setState({ peekWidth: 500 });
});

describe("the page beside a peek", () => {
  /** Fails if the page runs on under an open peek, which left a Pods list's Node, IP and Age behind it where no scroll could bring them out. */
  it("ends where an open peek begins", async () => {
    await renderWithRouter(<Page />, {
      at: "/c/prod/pods?peek=pods%2Fns%2Fapi-1",
    });
    expect(page().style.marginRight).toBe("500px");
  });

  /** Fails if the page keeps a peek's width when no peek is open. */
  it("takes the whole width with no peek open", async () => {
    await renderWithRouter(<Page />, { at: "/c/prod/pods" });
    expect(page().style.marginRight).toBe("");
  });
});
