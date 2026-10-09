import { createRouter } from "@tanstack/react-router";
import type { QueryClient } from "@tanstack/react-query";

import { routeTree } from "@/generated/routeTree.gen";
import { setRouter } from "@/lib/links";
import { navigationRendered } from "@/lib/perf-navigation";

export function makeRouter(queryClient: QueryClient) {
  const router = createRouter({
    routeTree,
    context: { queryClient },
    defaultPreload: "intent",
    // React Query owns freshness; a router cache in front of it would serve
    // a preload the watch has already replaced.
    defaultPreloadStaleTime: 0,
    scrollRestoration: true,
  });
  router.subscribe("onRendered", ({ toLocation }) => {
    const match = router.state.matches.at(-1);
    navigationRendered(match?.fullPath ?? toLocation.pathname);
  });
  setRouter(router);
  return router;
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof makeRouter>;
  }
}
