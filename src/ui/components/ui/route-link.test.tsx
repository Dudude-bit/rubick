import type { ReactNode } from "react";
import { beforeEach, describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import { RouteLink } from "./route-link";
import { useObjectMenuStore } from "@/stores/objectMenuStore";

const wrap = (ui: ReactNode) => render(<MemoryRouter>{ui}</MemoryRouter>);

describe("the right-click menu of a link that is not a resource reference", () => {
  beforeEach(() => useObjectMenuStore.setState({ target: null }));

  /**
   * Issue #178 item 1 was about the webview's own menu, whose "Copy link
   * address" copies `http://tauri.localhost/...`. The fix reached
   * `ObjectLink` and not this one — which is every custom resource, every
   * Helm release and every CRD, the largest family of rows in the app.
   * `preventDefault` is asserted because it is the whole of what stops the
   * webview menu appearing.
   */
  it("opens the app's menu at the pointer and claims the event", () => {
    wrap(<RouteLink to="/helm/shop/api">api</RouteLink>);
    const claimed = fireEvent.contextMenu(screen.getByRole("link"), {
      clientX: 12,
      clientY: 34,
    });
    expect(claimed).toBe(false);
    expect(useObjectMenuStore.getState().target).toEqual({
      name: "api",
      to: "/helm/shop/api",
      x: 12,
      y: 34,
    });
  });

  /**
   * A CRD row is labelled with its kind and called
   * `applications.argoproj.io`; "Copy name" must give the name. Fails if
   * the menu goes back to reading the words on screen for every link.
   */
  it("copies the object's name where the label is not it", () => {
    wrap(
      <RouteLink
        to="/customresourcedefinitions/applications.argoproj.io"
        menuName="applications.argoproj.io"
      >
        Application
      </RouteLink>
    );
    fireEvent.contextMenu(screen.getByRole("link"));
    expect(useObjectMenuStore.getState().target?.name).toBe(
      "applications.argoproj.io"
    );
  });
});
