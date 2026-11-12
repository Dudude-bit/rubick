import { expect, it, vi } from "vite-plus/test";

import { keptByName, namesRebound } from "./kept-by-name";

/**
 * Fails if a holder is not told the names were rebound, or one that was
 * taken off (a hook that unmounted) is still called.
 */
it("tells every holder still named, and none that was taken off", () => {
  const counts = vi.fn();
  const baseline = vi.fn();
  keptByName(counts);
  const off = keptByName(baseline);

  namesRebound();
  off();
  namesRebound();

  expect(counts).toHaveBeenCalledTimes(2);
  expect(baseline).toHaveBeenCalledTimes(1);
});
