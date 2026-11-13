import { describe, expect, it, vi } from "vite-plus/test";
import { renderHook } from "@testing-library/react";

const asked = vi.hoisted(() => ({
  options: null as { refresh?: unknown } | null,
}));

vi.mock("@/hooks/useLiveQuery", () => ({
  useLiveQuery: (options: { refresh?: unknown }) => {
    asked.options = options;
    return { data: undefined };
  },
}));

import { useController } from "./data";

describe("the Argo controller read", () => {
  /**
   * The controller read was a plain useQuery beside pages polling at the
   * resource-list rate, so its tab went stale while the rest refreshed and
   * kept polling off screen. Fails if it stops asking useLiveQuery for that
   * rate.
   */
  it("polls through useLiveQuery at the resource-list rate like the page's other reads", () => {
    renderHook(() => useController());
    expect(asked.options?.refresh).toBe("resourceList");
  });
});
