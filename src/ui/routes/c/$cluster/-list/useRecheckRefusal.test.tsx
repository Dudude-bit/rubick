import { renderHook, act } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { useWindowActivity } from "@/lib/window-activity";
import { REFUSAL_RECHECK_MS, useRecheckRefusal } from "./useRecheckRefusal";

afterEach(() => useWindowActivity.setState({ focused: true }));

describe("asking a refused list again", () => {
  /** A refusal that is minutes old and never re-asked keeps a list "refused" after access came back; deleting the recheck brings that back. */
  it("asks again on mount when the refusal is older than the interval", () => {
    const retry = vi.fn();
    renderHook(() =>
      useRecheckRefusal(Date.now() - REFUSAL_RECHECK_MS - 1000, retry)
    );
    expect(retry).toHaveBeenCalledTimes(1);
  });

  /** A refusal just said is not worth asking again at once. */
  it("leaves a fresh refusal alone", () => {
    const retry = vi.fn();
    renderHook(() => useRecheckRefusal(Date.now() - 1000, retry));
    expect(retry).not.toHaveBeenCalled();
  });

  /** Nothing refused, nothing to re-ask. */
  it("does nothing for a list that was not refused", () => {
    const retry = vi.fn();
    renderHook(() => useRecheckRefusal(null, retry));
    expect(retry).not.toHaveBeenCalled();
  });

  /** Coming back to the window is the other moment rights may have changed. */
  it("asks again when the window regains focus", () => {
    useWindowActivity.setState({ focused: false });
    const retry = vi.fn();
    renderHook(() =>
      useRecheckRefusal(Date.now() - REFUSAL_RECHECK_MS - 1000, retry)
    );
    expect(retry).not.toHaveBeenCalled();
    act(() => useWindowActivity.setState({ focused: true }));
    expect(retry).toHaveBeenCalledTimes(1);
  });
});
