import { useEffect } from "react";
import { commands } from "@/lib/commands";
import { useClusterStore } from "@/stores/clusterStore";
import { useThemeStore } from "@/stores/themeStore";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { RefreshButton } from "@/components/ui/refresh-button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Search, Moon, Sun, Monitor, Command, AlertCircle } from "lucide-react";
import { ActivityPanel } from "./ActivityPanel";
import { cn } from "@/lib/utils";
import { useQuery } from "@tanstack/react-query";
import { Spinner } from "@/components/ui/spinner";

export function Header() {
  // Subscribe to each field individually so the Header (and its
  // children — RefreshButton, ActivityPanel, the namespace/context
  // selectors) only re-renders when the field it actually displays
  // changes. Destructuring the whole store re-renders on every
  // unrelated field tick (toast queue, port-forward updates, etc.).
  const contexts = useClusterStore((s) => s.contexts);
  const currentContext = useClusterStore((s) => s.currentContext);
  const currentNamespace = useClusterStore((s) => s.currentNamespace);
  const isConnected = useClusterStore((s) => s.isConnected);
  const isLoading = useClusterStore((s) => s.isLoading);
  const isAuthenticating = useClusterStore((s) => s.isAuthenticating);
  const error = useClusterStore((s) => s.error);
  const pendingContext = useClusterStore((s) => s.pendingContext);
  const errorContext = useClusterStore((s) => s.errorContext);
  const loadContexts = useClusterStore((s) => s.loadContexts);
  const switchContext = useClusterStore((s) => s.switchContext);
  const switchNamespace = useClusterStore((s) => s.switchNamespace);
  const connect = useClusterStore((s) => s.connect);
  const theme = useThemeStore((s) => s.theme);
  const setTheme = useThemeStore((s) => s.setTheme);

  // Load contexts on mount and auto-connect
  useEffect(() => {
    const initConnection = async () => {
      await loadContexts();
    };
    initConnection();
  }, [loadContexts]);

  // Auto-connect when currentContext is set but not connected
  useEffect(() => {
    if (
      currentContext &&
      !isConnected &&
      !isLoading &&
      !isAuthenticating &&
      !error &&
      !pendingContext
    ) {
      connect(currentContext);
    }
  }, [
    currentContext,
    isConnected,
    isLoading,
    isAuthenticating,
    error,
    pendingContext,
    connect,
  ]);

  // Fetch namespaces when connected
  const { data: namespaces = [], refetch: refetchNamespaces } = useQuery({
    queryKey: ["namespaces", currentContext],
    queryFn: async () => {
      const result = await commands.listNamespaces();
      return result.map((ns: { name: string }) => ns.name);
    },
    enabled: isConnected,
  });

  const handleContextChange = (context: string) => {
    switchContext(context);
    connect(context);
  };

  const handleRetryConnection = async () => {
    const targetContext = errorContext || currentContext;
    if (!targetContext) return;
    // Don't call loadContexts() here — it has a side-effect that fires
    // its own connect(prefs.lastContext) without awaiting, which races
    // with this explicit retry: clusterStore.connect's
    // "already authenticating" guard then no-ops the second call and
    // the user sees no visible reconnect happen. The backend
    // `connect_cluster` already drops the cached client, reloads the
    // kubeconfig, and re-runs prepare_kubeconfig_for_context — so a
    // bare `connect(target)` is a full clean retry, including a fresh
    // auth-modal spawn if the user landed on an exec/oidc context.
    await connect(targetContext);
  };

  return (
    <header className="flex h-11 items-center justify-between border-b border-hair px-4">
      {/* Left: Cluster and Namespace selectors */}
      <div className="flex items-center gap-4">
        {/* Cluster selector */}
        <div className="flex items-center gap-2">
          <span className="text-sm text-muted-foreground">Cluster:</span>
          <Select
            value={currentContext || ""}
            onValueChange={handleContextChange}
          >
            <SelectTrigger className="w-48">
              <SelectValue placeholder="Select cluster" />
            </SelectTrigger>
            <SelectContent>
              {contexts.map((ctx) => (
                <SelectItem key={ctx.name} value={ctx.name}>
                  {ctx.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          {/* Connection status indicator */}
          <Tooltip>
            <TooltipTrigger asChild>
              <div className="flex items-center gap-1.5">
                {isLoading ? (
                  <Spinner size="sm" className="text-muted-foreground" />
                ) : error ? (
                  <AlertCircle className="h-4 w-4 text-err" />
                ) : (
                  <div
                    className={cn(
                      "h-2.5 w-2.5 rounded-full",
                      isConnected ? "bg-ok" : "bg-fg-fnt"
                    )}
                  />
                )}
              </div>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="max-w-xs">
              {isLoading ? (
                <span>
                  Connecting to {pendingContext || currentContext || "cluster"}
                  ...
                </span>
              ) : error ? (
                <div className="space-y-1">
                  <div className="font-medium text-err">Connection Error</div>
                  <div className="text-xs text-muted-foreground break-words">
                    {errorContext ? `${errorContext}: ${error}` : error}
                  </div>
                </div>
              ) : isConnected ? (
                <span className="text-ok">Connected to {currentContext}</span>
              ) : (
                <span>Not connected. Select a cluster to connect.</span>
              )}
            </TooltipContent>
          </Tooltip>

          {(errorContext || currentContext) && (
            <Tooltip>
              <TooltipTrigger asChild>
                <RefreshButton
                  onRefresh={handleRetryConnection}
                  isRefreshing={isLoading || isAuthenticating}
                  variant="ghost"
                  size="icon"
                />
              </TooltipTrigger>
              <TooltipContent side="bottom">
                {error
                  ? "Retry connection"
                  : "Reconnect (force re-authentication)"}
              </TooltipContent>
            </Tooltip>
          )}
        </div>

        {/* Namespace selector */}
        {isConnected && (
          <div className="flex items-center gap-2">
            <span className="text-sm text-muted-foreground">Namespace:</span>
            <Select
              value={currentNamespace || "__all__"}
              onValueChange={(value) =>
                switchNamespace(value === "__all__" ? "" : value)
              }
            >
              <SelectTrigger className="w-40">
                <SelectValue placeholder="Select namespace" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__all__">
                  <span className="font-medium">All namespaces</span>
                </SelectItem>
                {namespaces.map((ns) => (
                  <SelectItem key={ns} value={ns}>
                    {ns}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}

        {/* Refresh button */}
        {isConnected && !error && (
          <RefreshButton
            onRefresh={() => refetchNamespaces()}
            variant="ghost"
            size="icon"
          />
        )}
      </div>

      {/* Right: Activity, Search, and theme */}
      <div className="flex items-center gap-2">
        {/* Activity panel */}
        <ActivityPanel />

        {/* Command palette trigger */}
        <Button
          variant="outline"
          className="justify-start text-sm text-muted-foreground"
          onClick={() => {
            window.dispatchEvent(new CustomEvent("command-palette-open"));
          }}
        >
          <Search className="mr-2 h-4 w-4" />
          Search...
          <kbd className="ml-auto inline-flex h-5 items-center gap-1 rounded border bg-muted px-1.5 font-mono text-[10px] font-medium text-muted-foreground">
            <Command className="h-3 w-3" />K
          </kbd>
        </Button>

        {/* Theme toggle */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon">
              {theme === "light" && <Sun className="h-4 w-4" />}
              {theme === "dark" && <Moon className="h-4 w-4" />}
              {theme === "system" && <Monitor className="h-4 w-4" />}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={() => setTheme("light")}>
              <Sun className="mr-2 h-4 w-4" />
              Light
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => setTheme("dark")}>
              <Moon className="mr-2 h-4 w-4" />
              Dark
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => setTheme("system")}>
              <Monitor className="mr-2 h-4 w-4" />
              System
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );
}
