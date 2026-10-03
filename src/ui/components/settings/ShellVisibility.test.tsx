import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ShellVisibility } from "./ShellVisibility";
import { useSurfaceVisible } from "@/lib/surface-visibility";
import { useSettingsStore } from "@/stores/settingsStore";

/** Renders the answer rather than assigning it out of the render pass. */
function Probe() {
  return <span data-testid="seen">{String(useSurfaceVisible())}</span>;
}

/**
 * Would break if the routed shell went back to polling behind the layer.
 *
 * Settings was a route, and a route swap unmounted the page it replaced. As a
 * sibling of `<Routes>` it does not, so an opaque full-window cover left the
 * page under it asking the cluster questions nobody could see the answers to.
 */
describe("what the page under the settings layer is told", () => {
  it("is off screen while the layer is open", () => {
    useSettingsStore.setState({ open: true });

    render(
      <ShellVisibility>
        <Probe />
      </ShellVisibility>
    );

    expect(screen.getByTestId("seen")).toHaveTextContent("false");
  });

  it("is on screen again once it closes", () => {
    useSettingsStore.setState({ open: false });

    render(
      <ShellVisibility>
        <Probe />
      </ShellVisibility>
    );

    expect(screen.getByTestId("seen")).toHaveTextContent("true");
  });
});
