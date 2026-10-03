import { useRouterState } from "@tanstack/react-router";

const locationHref = (state: {
  location: { pathname: string; searchStr: string };
}) => `${state.location.pathname}${state.location.searchStr}`;

/** Where the window is, the way a tab or a link stores it: the path and its query. */
export function useLocationHref(): string {
  return useRouterState({ select: locationHref });
}
