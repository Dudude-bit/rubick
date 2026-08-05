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
import { logDebug, logError, logInfo } from "@/lib/logger";
import { registerBuiltInPlugins } from "@/lib/crd-plugins/plugins";
import { STALE_TIMES } from "@/lib/refresh";
import { commands } from "@/lib/commands";
import { setHostOs } from "@/lib/platform";

// Register built-in CRD plugins for enhanced UI
registerBuiltInPlugins();

// Resolved once at boot. Rendering a shortcut is synchronous, so the
// value has to be in place before the first paint that shows one.
void commands
  .getAppInfo()
  .then((info) => setHostOs(info.os))
  .catch(() => {
    /* keep the ctrl fallback */
  });

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
    onSuccess: (_data, query) => {
      logDebug("Query success", {
        context: "react-query",
        data: {
          queryKey: formatKey(query.queryKey),
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
      refetchOnWindowFocus: false,
    },
  },
});

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
