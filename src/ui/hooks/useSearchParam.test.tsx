import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { act, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vite-plus/test";

import { appSearch } from "@/lib/app-search";
import { renderWithRouter } from "@/test/render";
import { useSearchParam, useSetSearch } from "./useSearchParam";

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

describe("a query written in place", () => {
  /**
   * Lena's second pick from "ещё N" opened its tab and left it off screen:
   * the strip scrolled to it while the write was drawn, and the router then
   * put the strip back where it was. Fails if a box scrolled during the
   * write is moved back afterwards.
   */
  it("leaves a box scrolled while it is drawn where it was scrolled to", async () => {
    let write: ReturnType<typeof useSetSearch> = () => {};
    function Page() {
      write = useSetSearch();
      return <div data-testid="strip" />;
    }
    const root = createRootRoute({ component: Outlet });
    const router = createRouter({
      routeTree: root.addChildren([
        createRoute({
          getParentRoute: () => root,
          path: "/c/$cluster/$",
          validateSearch: appSearch,
          component: Page,
        }),
      ]),
      history: createMemoryHistory({
        initialEntries: ["/c/prod/pods/shop/web"],
      }),
      scrollRestoration: true,
    });
    await act(() => router.load());
    render(<RouterProvider router={router} />);
    const strip = await screen.findByTestId("strip");
    strip.scrollLeft = 100;
    strip.dispatchEvent(new Event("scroll"));
    const stop = router.subscribe("onBeforeLoad", () => {
      strip.scrollLeft = 300;
    });

    act(() => write({ tab: "yaml" }));
    await vi.waitFor(() =>
      expect(router.state.location.searchStr).toBe("?tab=yaml")
    );
    await act(() => router.load());
    stop();
    expect(strip.scrollLeft).toBe(300);
  });
});
