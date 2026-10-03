import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { describe, expect, it } from "vitest";

import { useSearchParam } from "./useSearchParam";

const at =
  (entry: string) =>
  ({ children }: { children: ReactNode }) => (
    <MemoryRouter initialEntries={[entry]}>{children}</MemoryRouter>
  );

function useFilterAndAddress() {
  const [q, setQ] = useSearchParam("q");
  return { q, setQ, search: useLocation().search };
}

describe("a query parameter as state", () => {
  /** The address is what a map node hands over; a page that ignored it showed every host. */
  it("starts from what the address says", () => {
    const { result } = renderHook(() => useSearchParam("q"), {
      wrapper: at("/traffic?tab=routes&q=shop.example.com"),
    });
    expect(result.current[0]).toBe("shop.example.com");
  });

  /** Typing keeps the other parameters, and clearing leaves no empty `q=` behind. */
  it("writes the address, keeping the rest of it", () => {
    const { result } = renderHook(useFilterAndAddress, {
      wrapper: at("/traffic?tab=routes"),
    });
    act(() => result.current.setQ("api"));
    expect(result.current.q).toBe("api");
    expect(result.current.search).toBe("?tab=routes&q=api");

    act(() => result.current.setQ("  "));
    expect(result.current.search).toBe("?tab=routes");
  });
});
