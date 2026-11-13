import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { act, render, screen } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vite-plus/test";

import { followPathChange, pageScroll } from "@/lib/page-scroll";

function Shell() {
  return (
    <main id="main-content" data-testid="main">
      <Outlet />
    </main>
  );
}

async function twoPages() {
  const root = createRootRoute({ component: Shell });
  const page = (path: string) =>
    createRoute({
      getParentRoute: () => root,
      path,
      component: () => <p>{path}</p>,
    });
  const router = createRouter({
    routeTree: root.addChildren([page("/events"), page("/overview")]),
    history: createMemoryHistory({ initialEntries: ["/events"] }),
    ...pageScroll,
  });
  followPathChange(router);
  await act(() => router.load());
  render(<RouterProvider router={router} />);
  await screen.findByText("/events");
  return router;
}

const main = () => screen.getByTestId("main");

async function scrollDown(router: Awaited<ReturnType<typeof twoPages>>) {
  main().scrollTop = 800;
  main().dispatchEvent(new Event("scroll"));
  return router;
}

describe("the shell's main scroller across routes", () => {
  beforeAll(() => {
    Element.prototype.scrollTo = function (this: Element, options) {
      this.scrollTop = (options as ScrollToOptions).top ?? 0;
    };
    vi.spyOn(window, "scrollTo").mockImplementation(() => {});
  });

  /** Fails if Overview opens at the offset Events was scrolled to. */
  it("opens a page reached from a scrolled one at the top", async () => {
    const router = await scrollDown(await twoPages());
    await act(async () => {
      router.history.push("/overview");
      await router.load();
    });
    await screen.findByText("/overview");
    expect(main().scrollTop).toBe(0);
  });

  /** Fails if a filter change on the same page throws the reader to the top. */
  it("keeps its place when only the search changes", async () => {
    const router = await scrollDown(await twoPages());
    await act(async () => {
      router.history.push("/events?filter=a");
      await router.load();
    });
    expect(main().scrollTop).toBe(800);
  });

  /** Fails if going back no longer puts the earlier page where it was. */
  it("is put back where it was on the way back", async () => {
    const router = await scrollDown(await twoPages());
    await act(async () => {
      router.history.push("/overview");
      await router.load();
    });
    await screen.findByText("/overview");
    await act(async () => {
      router.history.back();
      await router.load();
    });
    await screen.findByText("/events");
    expect(main().scrollTop).toBe(800);
  });
});
