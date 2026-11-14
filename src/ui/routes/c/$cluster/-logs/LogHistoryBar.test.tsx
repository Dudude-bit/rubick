import { screen } from "@testing-library/react";
import { describe, expect, it } from "vite-plus/test";

import { renderWithRouter } from "@/test/render";
import { LogHistoryBar } from "./LogHistoryBar";

const props = {
  history: { state: "idle" as const },
  stranded: "web-1",
  ranged: false,
  held: 0,
  keep: 1000,
  selected: null,
  isPaging: false,
  onRead: () => {},
  onReadOlder: () => {},
  onClear: () => {},
};

describe("the log history bar", () => {
  /** With nothing configured, the dead end is the one place to offer a store. */
  it("offers a log store beside a pod whose lines are gone, when none is configured", async () => {
    await renderWithRouter(
      <LogHistoryBar {...props} capability={{ state: "absent" }} />,
      { at: "/c/prod/pods", route: "/c/$cluster/pods" }
    );
    expect(screen.getByTestId("log-history-absent")).toBeInTheDocument();
  });

  /** A store the reader configured is still being probed: offering to
   *  connect one would offer what they already did. */
  it("offers nothing while the configured store is still being asked", async () => {
    await renderWithRouter(
      <LogHistoryBar {...props} capability={{ state: "reading" }} />,
      { at: "/c/prod/pods", route: "/c/$cluster/pods" }
    );
    expect(document.querySelector('[data-testid^="log-history"]')).toBeNull();
  });
});
