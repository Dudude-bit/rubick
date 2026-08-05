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

// The rendered modifier differs per platform and Kbd reads it
// synchronously, so resolve it before the first paint rather than
// letting an early mount render the wrong glyph with no way to
// re-render. A hung IPC must not white-screen the app, so the wait is
// bounded and falls back to the Ctrl default.
async function resolveHostOs(): Promise<void> {
  try {
    const info = await Promise.race([
      commands.getAppInfo(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("timeout")), 2000)
      ),
    ]);
    setHostOs(info.os);
  } catch {
    // keep the Ctrl fallback
  }
}

void resolveHostOs().then(() => {
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
});
