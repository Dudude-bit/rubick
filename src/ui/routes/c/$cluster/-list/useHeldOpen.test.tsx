import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vite-plus/test";

import { useHeldOpen } from "./useHeldOpen";

describe("useHeldOpen", () => {
  /** A close that arrives while the write is unanswered must not reach the caller, or the dialog vanishes under its own pending mark. */
  it("ignores a close while the held write is unanswered and allows it after", async () => {
    const close = vi.fn();
    const { result } = renderHook(() => useHeldOpen(close));
    let settle!: () => void;
    const held = result.current.hold(
      new Promise<void>((resolve) => (settle = resolve))
    );

    result.current.onOpenChange(false);
    expect(close).not.toHaveBeenCalled();

    settle();
    await held;
    result.current.onOpenChange(false);
    expect(close).toHaveBeenCalledTimes(1);
  });

  /** An open request is never swallowed. */
  it("lets an open request through", () => {
    const close = vi.fn();
    const { result } = renderHook(() => useHeldOpen(close));
    result.current.onOpenChange(true);
    expect(close).not.toHaveBeenCalled();
  });
});
