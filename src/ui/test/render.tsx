import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
  type AnyRouter,
} from "@tanstack/react-router";
import { act, render, type RenderOptions } from "@testing-library/react";
import { useSyncExternalStore, type ReactElement, type ReactNode } from "react";

import { TooltipProvider } from "@/components/ui/tooltip";
import { appSearch } from "@/lib/app-search";
import { setRouter } from "@/lib/links";

/**
 * A client for one test. React Query's own default retries a failed query
 * three times, one, two and four seconds apart, so a test expecting an error
 * waited seven seconds for it or timed out first. A hook that asks for its
 * own retries still gets them, without the wait.
 */
export function testQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, retryDelay: 0 } },
  });
}

export interface TestRouterOptions {
  /** Where the window starts. */
  at?: string;
  /**
   * The route pattern `ui` is mounted at, so `useParams` sees its params:
   * `/c/$cluster/pods/$namespace/$name`. Without one it is mounted at any
   * address inside a cluster, which is what links need to resolve.
   */
  route?: string;
}

/**
 * A memory router with `ui` mounted at one route. A navigation away from it
 * is read off `router.state.location`, and the link builders resolve against
 * it the way they do in the app.
 */
/** An element a mounted route can be handed again, as RTL's `rerender` would. */
function swappable(first: ReactNode) {
  let current = first;
  const listeners = new Set<() => void>();
  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };
  function Current() {
    return <>{useSyncExternalStore(subscribe, () => current)}</>;
  }
  const swap = (next: ReactNode) => {
    current = next;
    listeners.forEach((listener) => listener());
  };
  return { Current, swap };
}

export function testRouter(
  ui: ReactNode,
  { at = "/c/test", route = "/c/$cluster/$" }: TestRouterOptions = {}
): AnyRouter {
  return testRouterWith(swappable(ui).Current, { at, route });
}

function testRouterWith(
  Page: () => ReactNode,
  { at = "/c/test", route = "/c/$cluster/$" }: TestRouterOptions
): AnyRouter {
  const root = createRootRoute({ component: Outlet });
  const page = createRoute({
    getParentRoute: () => root,
    path: route,
    validateSearch: appSearch,
    component: Page,
  });
  const router = createRouter({
    routeTree: root.addChildren([page]),
    history: createMemoryHistory({ initialEntries: [at] }),
    defaultPendingMinMs: 0,
  });
  setRouter(router);
  return router;
}

export interface ProviderOptions extends Omit<RenderOptions, "wrapper"> {
  /** Pass one to seed or read the cache; otherwise each render gets a fresh one. */
  client?: QueryClient;
}

function providers(client: QueryClient) {
  return function Providers({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={client}>
        <TooltipProvider>{children}</TooltipProvider>
      </QueryClientProvider>
    );
  };
}

/**
 * `ui` inside what the app's root mounts around everything: the query
 * client and the tooltip provider. They go in as the `wrapper`, so
 * `rerender` keeps them. No router: see {@link renderWithRouter}.
 */
export function renderWithProviders(
  ui: ReactElement,
  { client = testQueryClient(), ...options }: ProviderOptions = {}
) {
  return { client, ...render(ui, { wrapper: providers(client), ...options }) };
}

/**
 * The same, inside a router that has finished its first load, so the page
 * is on screen when this resolves. Navigations are read off
 * `router.state.location`.
 */
export async function renderWithRouter(
  ui: ReactElement,
  {
    client = testQueryClient(),
    at,
    route,
    ...options
  }: ProviderOptions & TestRouterOptions = {}
) {
  const page = swappable(ui);
  const router = testRouterWith(page.Current, { at, route });
  await act(() => router.load());
  const rendered = render(<RouterProvider router={router} />, {
    wrapper: providers(client),
    ...options,
  });
  return {
    client,
    router,
    ...rendered,
    rerender: (next: ReactElement) => act(() => page.swap(next)),
  };
}

/** Lets a navigation that was going to happen finish, so "nothing moved" means it. */
export async function settle(router: AnyRouter): Promise<void> {
  await act(() => router.load());
}
