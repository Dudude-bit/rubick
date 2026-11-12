import { render } from "@testing-library/react";
import { describe, expect, it } from "vite-plus/test";

import {
  ScreenShareProvider,
  useScreenCaveats,
} from "@/components/share/screen-share";
import { StaleRows } from "./StaleRows";

let said: (() => string[]) | null = null;
function Probe() {
  said = useScreenCaveats();
  return null;
}

const answered = Date.UTC(2026, 10, 12, 14, 5);

/**
 * A list, a CRD list, the Helm releases and every detail page keep what a
 * failed re-read left and say so in this notice. Share stamped the file
 * with the moment of sharing and wrote the old rows under it with
 * "Everything this report names was read". Fails if the notice is on
 * screen and the screen's file is not told, or is told a local time.
 */
describe("rows a failed re-read left, in what the screen shares", () => {
  it("says in the file when they were read, in UTC, and why not since", () => {
    render(
      <ScreenShareProvider>
        <StaleRows
          label="pods"
          since={answered}
          error={new Error("502 Bad Gateway")}
        />
        <Probe />
      </ScreenShareProvider>
    );
    expect(said!()).toEqual([
      "Could not read pods when this was made: what the file shows of it is from 2026-11-12 14:05 UTC, the last read that answered. (502 Bad Gateway)",
    ]);
  });

  it("says nothing once the notice is gone", () => {
    const { rerender } = render(
      <ScreenShareProvider>
        <StaleRows label="pods" since={answered} error={new Error("502")} />
        <Probe />
      </ScreenShareProvider>
    );
    rerender(
      <ScreenShareProvider>
        <Probe />
      </ScreenShareProvider>
    );
    expect(said!()).toEqual([]);
  });

  /** Events says it in its own section, which then holds no rows to call old. */
  it("says nothing where the screen's own section already does", () => {
    render(
      <ScreenShareProvider>
        <StaleRows
          label="events"
          shared={false}
          since={answered}
          error={new Error("502")}
        />
        <Probe />
      </ScreenShareProvider>
    );
    expect(said!()).toEqual([]);
  });
});
