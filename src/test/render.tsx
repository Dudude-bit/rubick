import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, type RenderOptions } from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";
import { MemoryRouter } from "react-router-dom";

import { TooltipProvider } from "@/components/ui/tooltip";

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

export interface ProviderOptions extends Omit<RenderOptions, "wrapper"> {
  /** Pass one to seed or read the cache; otherwise each render gets a fresh one. */
  client?: QueryClient;
  /** Mounts a `MemoryRouter` at these addresses. Without it there is no router. */
  initialEntries?: string[];
}

/**
 * `ui` inside what the app's root mounts around everything: the query
 * client and the tooltip provider, and a router when `initialEntries` asks
 * for one. They go in as the `wrapper`, so `rerender` keeps them.
 */
export function renderWithProviders(
  ui: ReactElement,
  {
    client = testQueryClient(),
    initialEntries,
    ...options
  }: ProviderOptions = {}
) {
  function Providers({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={client}>
        <TooltipProvider>
          {initialEntries ? (
            <MemoryRouter initialEntries={initialEntries}>
              {children}
            </MemoryRouter>
          ) : (
            children
          )}
        </TooltipProvider>
      </QueryClientProvider>
    );
  }
  return { client, ...render(ui, { wrapper: Providers, ...options }) };
}
