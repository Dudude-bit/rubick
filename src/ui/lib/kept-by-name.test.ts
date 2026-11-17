import { expect, it, vi } from "vite-plus/test";

import {
  keptByName,
  nameIsAnotherCluster,
  namesRebound,
  persistedByName,
} from "./kept-by-name";

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

/**
 * The prices store is loaded only with a lazy screen, after the one moment
 * a name is reported as another cluster. Named later, it is still told.
 * Fails if a holder named after the report kept the old cluster's data.
 */
it("tells a persisted holder named later every name that turned this session", () => {
  const early = vi.fn();
  const offEarly = persistedByName(early);
  nameIsAnotherCluster("prod");
  const late = vi.fn();
  const offLate = persistedByName(late);

  expect(early).toHaveBeenCalledExactlyOnceWith("prod");
  expect(late).toHaveBeenCalledExactlyOnceWith("prod");
  offEarly();
  offLate();
});
