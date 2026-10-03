import { act } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { renderWithRouter } from "@/test/render";
import { useSearchParam } from "./useSearchParam";

async function mountAt(at: string) {
  const result = {} as { current: ReturnType<typeof useSearchParam> };
  function Probe() {
    result.current = useSearchParam("q");
    return null;
  }
  const { router } = await renderWithRouter(<Probe />, {
    at,
    route: "/c/$cluster/integrations/$vendor",
  });
  return { result, router };
}

describe("a query parameter as state", () => {
  /** The address is what a map node hands over; a page that ignored it showed every host. */
  it("starts from what the address says", async () => {
    const { result } = await mountAt(
      "/c/prod/integrations/traefik?tab=routes&q=shop.example.com"
    );
    expect(result.current[0]).toBe("shop.example.com");
  });

  /** Typing keeps the other parameters, and clearing leaves no empty `q=` behind. */
  it("writes the address, keeping the rest of it", async () => {
    const { result, router } = await mountAt(
      "/c/prod/integrations/traefik?tab=routes"
    );
    act(() => result.current[1]("api"));
    await vi.waitFor(() =>
      expect(router.state.location.searchStr).toBe("?tab=routes&q=api")
    );
    await vi.waitFor(() => expect(result.current[0]).toBe("api"));

    act(() => result.current[1]("  "));
    await vi.waitFor(() =>
      expect(router.state.location.searchStr).toBe("?tab=routes")
    );
  });
});
