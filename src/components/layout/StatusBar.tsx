import { Monitor, Moon, Sun } from "lucide-react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useClusterSummary } from "@/hooks/useClusterSummary";
import { formatShortcut } from "@/lib/platform";
import { cn } from "@/lib/utils";
import { useClusterStore } from "@/stores/clusterStore";
import { useThemeStore } from "@/stores/themeStore";
import { ActivityPanel } from "./ActivityPanel";
import { useT } from "@/i18n/useT";

/**
 * The window's bottom line: what the keyboard does on the left, what is
 * true of the connection on the right. It is the only always-visible place
 * that carries a live problem count, so the number is red the moment it
 * is non-zero — the user should never have to open a page to learn that
 * something broke.
 *
 * It reports states, never names. The cluster used to be spelled out here
 * as well as in the sidebar and in the tab, three times in one window for
 * a fact that does not change while you read it; now that a tab carries a
 * route as well as a scope, the strip and the sidebar are enough. What is
 * left here is the only thing this line knew that they did not: whether
 * the connection behind them is actually up.
 */
export function StatusBar() {
  const t = useT();
  const currentContext = useClusterStore((s) => s.currentContext);
  const isConnected = useClusterStore((s) => s.isConnected);
  const isLoading = useClusterStore((s) => s.isLoading);
  const isAuthenticating = useClusterStore((s) => s.isAuthenticating);
  const error = useClusterStore((s) => s.error);
  const errorContext = useClusterStore((s) => s.errorContext);
  const pendingContext = useClusterStore((s) => s.pendingContext);
  const connect = useClusterStore((s) => s.connect);
  const { podCount, problemCount, problemsTruncated } = useClusterSummary();

  const connecting = isLoading || isAuthenticating;

  return (
    <footer className="flex h-6 flex-none items-center gap-3.5 border-t border-hair px-3 text-[11px] text-fg-fnt">
      <span>{"↵"} open</span>
      <span>{"↑↓"} move</span>
      <span>{formatShortcut("mod+K")} search</span>

      <div className="flex-1" />

      <ActivityPanel />
      <ThemeControl />

      {connecting ? (
        // The one place a name still belongs: mid-connect the sidebar and
        // the tab are still showing the cluster being left behind.
        <span className="truncate">
          connecting to {pendingContext ?? currentContext}…
        </span>
      ) : error ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={() =>
                connect(errorContext ?? currentContext ?? undefined)
              }
              className="text-err transition-colors hover:text-fg"
            >
              connection failed — retry
            </button>
          </TooltipTrigger>
          <TooltipContent side="top" align="end" className="max-w-[420px]">
            {error}
          </TooltipContent>
        </Tooltip>
      ) : isConnected ? (
        <>
          <span>{t("cluster", "podCount", { n: podCount })}</span>
          <span>·</span>
          <span className={cn(problemCount > 0 && "text-err")}>
            {t("cluster", "problemCount", { n: problemCount })}
            {/* The backend caps its ranked list; saying "12+" is the
                difference between a count and a guess. */}
            {problemsTruncated > 0 && "+"}
          </span>
        </>
      ) : (
        <span>not connected</span>
      )}
    </footer>
  );
}

const THEMES = [
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
  { value: "system", label: "System", icon: Monitor },
] as const;

function ThemeControl() {
  const theme = useThemeStore((s) => s.theme);
  const setTheme = useThemeStore((s) => s.setTheme);
  const current = THEMES.find((t) => t.value === theme) ?? THEMES[2];
  const Icon = current.icon;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={`Theme: ${current.label}`}
          className="flex items-center gap-1.5 rounded px-1.5 text-[11px] text-fg-fnt transition-colors hover:text-fg"
        >
          <Icon className="h-3 w-3" />
          {current.label.toLowerCase()}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" side="top">
        {THEMES.map((option) => (
          <DropdownMenuItem
            key={option.value}
            onClick={() => setTheme(option.value)}
          >
            <option.icon className="mr-2 h-4 w-4" />
            {option.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
