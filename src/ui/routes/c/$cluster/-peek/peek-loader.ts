import { lazy } from "react";

type ContentModule = typeof import("./peek-content");
let loaded: ContentModule | null = null;

/** Fetches the panel's body; the shell asks for it once the window has drawn. */
export function preloadPeekContent(): Promise<ContentModule> {
  return import("./peek-content").then((module) => (loaded = module));
}

/**
 * A body already fetched is handed over within the same render. A promise,
 * even a settled one, would suspend it for a frame and flash the outline
 * over a panel that was ready.
 */
export const PeekContent = lazy(() => {
  if (loaded) {
    const ready = { default: loaded.PeekContent };
    const now = {
      then: (resolve: (value: typeof ready) => void) => resolve(ready),
    };
    return now as unknown as Promise<typeof ready>;
  }
  return preloadPeekContent().then((module) => ({
    default: module.PeekContent,
  }));
});
