import { createRootRouteWithContext } from "@tanstack/react-router";
import type { QueryClient } from "@tanstack/react-query";

import App from "@/App";
import { NotFoundPage } from "./-components/NotFound";

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()(
  {
    component: App,
    notFoundComponent: NotFoundPage,
  }
);
