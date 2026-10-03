/**
 * The Flatpak bundle cannot replace its own binary: it runs from /app, a
 * read-only deploy mount, so an update it finds downloads ~100 MB and then
 * fails. Checking anyway nagged every thirty minutes about something only
 * `flatpak update` can do. Deleting the guard brings that back, and nothing
 * else in the suite would notice — which is why "unknown" is tested too: an
 * answer we could not get must keep behaving the way every other platform
 * does, not quietly switch updates off everywhere.
 */

import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/components/ui/use-toast", () => ({ toast: vi.fn() }));
vi.mock("@/i18n/useT", () => ({ useT: () => () => "" }));

import { useUpdaterStore } from "@/stores/updaterStore";
import { useAutoUpdater } from "./useAutoUpdater";

const checkForUpdates = vi.fn().mockResolvedValue(null);

function mount(canInstall: boolean | null) {
  useUpdaterStore.setState({
    settingsLoaded: true,
    autoCheckEnabled: true,
    available: false,
    canInstall,
    loadSettings: vi.fn().mockResolvedValue(undefined),
    checkForUpdates,
  });
  renderHook(() => useAutoUpdater());
  act(() => {
    vi.advanceTimersByTime(2_000);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  checkForUpdates.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("checking for updates a build could not install", () => {
  it("does not look when this build installs its updates through a package manager", () => {
    mount(false);
    expect(checkForUpdates).not.toHaveBeenCalled();
  });

  it("looks when the build can install what it finds", () => {
    mount(true);
    expect(checkForUpdates).toHaveBeenCalled();
  });

  it("looks when nobody could establish whether it can, which is not a no", () => {
    mount(null);
    expect(checkForUpdates).toHaveBeenCalled();
  });
});
