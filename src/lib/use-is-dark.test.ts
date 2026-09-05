import { describe, it, expect, afterEach } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useIsDark } from "./use-is-dark";

afterEach(() => {
  document.documentElement.classList.remove("dark");
});

describe("useIsDark", () => {
  /// A flip of the theme has to reach every coloured log line on screen
  /// in the same tick as the canvas, or the runs are drawn for the
  /// canvas that just went away.
  it("follows the class on the root as it changes", async () => {
    const { result } = renderHook(() => useIsDark());
    expect(result.current).toBe(false);
    await act(async () => {
      document.documentElement.classList.add("dark");
    });
    expect(result.current).toBe(true);
    await act(async () => {
      document.documentElement.classList.remove("dark");
    });
    expect(result.current).toBe(false);
  });
});
