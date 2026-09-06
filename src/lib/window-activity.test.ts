import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
}));

import { startWindowActivity, useWindowActivity } from "./window-activity";

afterEach(() => {
  useWindowActivity.setState({ visible: true, focused: true });
});

describe("the window activity listeners", () => {
  /**
   * The teardown named the event "blur-sm" — a Tailwind v4 class rename that a
   * codemod applied to a DOM event string. The `blur` listener was therefore
   * never removed, and every leaked one goes on writing `focused: false` into
   * the store that every `useLiveQuery` reads to pick its refresh rate.
   */
  it("stops answering a blur once it has been torn down", () => {
    const stop = startWindowActivity();
    stop();

    window.dispatchEvent(new Event("blur"));

    expect(useWindowActivity.getState().focused).toBe(true);
  });

  /** The other half: while it is running, a blur has to be noticed. */
  it("answers a blur while it is running", () => {
    const stop = startWindowActivity();

    window.dispatchEvent(new Event("blur"));

    expect(useWindowActivity.getState().focused).toBe(false);
    stop();
  });
});
