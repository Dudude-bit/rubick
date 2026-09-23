import React from "react";
import ReactDOM from "react-dom/client";
import {
  MutationCache,
  QueryCache,
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import { BrowserRouter } from "react-router-dom";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/toaster";
import App from "./App";
// Fonts are bundled, not fetched: the app's CSP is `style-src 'self'` /
// `font-src 'self' data:`, which blocks the Google Fonts stylesheet and
// the gstatic font files outright. Loading them from a CDN also breaks
// on the airgapped networks this tool is used on.
import "@fontsource-variable/inter";
import "@fontsource-variable/jetbrains-mono";
import "./index.css";
import { logError, logInfo } from "@/lib/logger";
import { STALE_TIMES } from "@/lib/refresh";
import { isWorthRetrying } from "@/lib/error-utils";
import { hostOsFromUserAgent, setHostOs } from "@/lib/platform";
import { markStartup } from "@/lib/startup";
import { loadLocale } from "@/i18n";
import { currentLocale } from "@/stores/localeStore";

// After every eagerly imported module has loaded.
markStartup("main");

const formatKey = (key: unknown) => {
  try {
    return JSON.parse(JSON.stringify(key));
  } catch {
    return String(key);
  }
};

const formatError = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

const queryClient = new QueryClient({
  queryCache: new QueryCache({
    onError: (error, query) => {
      logError("Query error", {
        context: "react-query",
        data: {
          queryKey: formatKey(query.queryKey),
          error: formatError(error),
        },
      });
    },
  }),
  mutationCache: new MutationCache({
    onError: (error, _variables, _context, mutation) => {
      logError("Mutation error", {
        context: "react-query",
        data: {
          mutationKey: formatKey(mutation.options.mutationKey),
          error: formatError(error),
        },
      });
    },
    onSuccess: (_data, _variables, _context, mutation) => {
      logInfo("Mutation success", {
        context: "react-query",
        data: {
          mutationKey: formatKey(mutation.options.mutationKey),
        },
      });
    },
  }),
  defaultOptions: {
    queries: {
      staleTime: STALE_TIMES.slow,
      // Every queryFn here is a Tauri call the Rust side answers, so the
      // webview's idea of being offline says nothing about whether the
      // cluster can be reached — kind on loopback, a port-forward, a VPN on
      // another interface. Left at the default, one `offline` event pauses
      // every query, and a paused query is `isLoading: false` with no data,
      // which every list draws as "this cluster has none of these".
      networkMode: "always",
      // Focus and visibility are `useLiveQuery`'s to decide — it refetches on
      // both, and for a group of queries at once. React Query's own listener
      // would fire underneath that.
      refetchOnWindowFocus: false,
      // One policy for the whole app, from the classifier the app already
      // owns: a blip is worth asking again, a verdict never is. See
      // `isWorthRetrying`.
      retry: (failureCount, error) =>
        failureCount < 2 && isWorthRetrying(error),
    },
    // A mutation shares the default, so a drain or a delete would sit paused
    // with nothing said either.
    mutations: { networkMode: "always" },
  },
});

// Kbd reads the platform synchronously, so it is set before the first render.
setHostOs(hostOsFromUserAgent(navigator.userAgent));

function render() {
  markStartup("root");
  ReactDOM.createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <BrowserRouter>
            <App />
            <Toaster />
          </BrowserRouter>
        </TooltipProvider>
      </QueryClientProvider>
    </React.StrictMode>
  );
}

// The reader's language before anything is drawn in it; English, which is
// built in, if its catalogue cannot be loaded.
loadLocale(currentLocale()).then(render, render);
