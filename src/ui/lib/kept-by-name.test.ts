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

/**
 * A persisted store whose write threw, a full localStorage, stopped the
 * walk: every holder named after it went on answering for the cluster
 * before. Fails if one holder's throw keeps the next from being told, on a
 * turn, on a rebind, or when it is named after a turn.
 */
it("tells every holder though one before it throws", () => {
  const throws = () => {
    throw new Error("QuotaExceededError");
  };
  const persistedAfter = vi.fn();
  const keptAfter = vi.fn();
  const offs = [
    persistedByName(throws),
    persistedByName(persistedAfter),
    keptByName(throws),
    keptByName(keptAfter),
  ];
  nameIsAnotherCluster("prod-after-a-throw");
  namesRebound();
  const namedLater = vi.fn();
  offs.push(persistedByName(throws), persistedByName(namedLater));
  for (const off of offs) off();
  expect(persistedAfter).toHaveBeenCalledWith("prod-after-a-throw");
  expect(keptAfter).toHaveBeenCalled();
  expect(namedLater).toHaveBeenCalledWith("prod-after-a-throw");
});
