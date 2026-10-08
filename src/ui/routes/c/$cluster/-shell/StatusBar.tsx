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
import { useScopedOverview } from "@/hooks/useClusterOverview";
import { useAttention } from "@/hooks/useAttention";
import { attentionWords, type Attention } from "@/lib/attention";
import { useClusterSummary } from "@/hooks/useClusterSummary";
import { useRenewal } from "@/hooks/useCredentialRenewal";
import type { Renewal } from "@/generated/types";
import { scopeLabel } from "@/lib/namespace-scope";
import { formatShortcut } from "@/lib/platform";
import { cn } from "@/lib/utils";
import { useShownPath } from "@/lib/hide-paths";
import { useClusterStore } from "@/stores/clusterStore";
import { useThemeStore } from "@/stores/themeStore";
import { ActivityPanel } from "./ActivityPanel";
import { LinkOpenedNote } from "./DeepLinkBanner";
import { StallIndicator } from "./StallIndicator";
import { useT } from "@/i18n/useT";

/**
 * Which renewal states put a sign-in hint in the strip, as a total map.
 *
 * Total, not a ternary chain ending in `null`: a chain paints every state it
 * has not heard of as "nothing to say", and `lastChance` — one attempt left,
 * landing after the deadline — would have arrived silently.
 */
const SIGN_IN_HINT: Record<
  Renewal,
  "renewalNeedsYouHint" | "renewalRanOutHint" | null
> = {
  needsYou: "renewalNeedsYouHint",
  ranOut: "renewalRanOutHint",
  // Coming, and nothing to do about it yet — the refusal lifts itself when
  // the attempt after the deadline lands.
  lastChance: "renewalRanOutHint",
  scheduled: null,
  noDeadline: null,
  passed: null,
  failed: null,
  delegated: null,
  unknown: null,
};

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
  const show = useShownPath();
  const currentContext = useClusterStore((s) => s.currentContext);
  const isConnected = useClusterStore((s) => s.isConnected);
  const connectedThrough = useClusterStore((s) => s.connectedThrough);
  const isLoading = useClusterStore((s) => s.isLoading);
  const isAuthenticating = useClusterStore((s) => s.isAuthenticating);
  const error = useClusterStore((s) => s.error);
  const errorContext = useClusterStore((s) => s.errorContext);
  const pendingContext = useClusterStore((s) => s.pendingContext);
  const connect = useClusterStore((s) => s.connect);
  const scope = useClusterStore((s) => s.namespaceScope);
  const scoped = useScopedOverview();
  const attention = useAttention();
  // A placeholder is the last scope's answer, and under this scope's label it
  // would count the wrong namespaces.
  const here =
    scoped.data && !scoped.isPlaceholderData && attention
      ? { pods: scoped.data.counts.pods, attention }
      : null;
  // The two worth a line that is always up — both predict the sign-in screen,
  // and they differ in why. Everything else is quiet, and a chip that is
  // permanently lit stops being read.
  const renewal = useRenewal();
  const signInHint = SIGN_IN_HINT[renewal];

  const connecting = isLoading || isAuthenticating;

  return (
    <footer className="flex h-6 flex-none items-center gap-3.5 border-t border-hair px-3 text-[11px] text-fg-fnt">
      <span>
        {"↵"} {t("action", "hintOpen")}
      </span>
      <span>
        {"↑↓"} {t("action", "hintMove")}
      </span>
      <span>
        {formatShortcut("mod+K")} {t("action", "hintSearch")}
      </span>

      <div className="flex min-w-0 flex-1">
        <LinkOpenedNote />
      </div>

      <StallIndicator />
      <ActivityPanel />
      <ThemeControl />
      {/* The app's own chrome to the left, the cluster's health to the right. */}
      <span aria-hidden="true" className="h-3 w-px flex-none bg-hair" />

      {connecting ? (
        // The one place a name still belongs: mid-connect the sidebar and
        // the tab are still showing the cluster being left behind.
        <span className="truncate">
          {t("cluster", "connectingToLower", {
            context: pendingContext ?? currentContext ?? "",
          })}
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
              {t("cluster", "connectionFailedRetry")}
            </button>
          </TooltipTrigger>
          <TooltipContent side="top" align="end" className="max-w-[420px]">
            {show(error)}
          </TooltipContent>
        </Tooltip>
      ) : isConnected ? (
        <>
          {connectedThrough === "kubectl_proxy" && (
            <>
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="cursor-default text-warn">
                    {t("cluster", "throughProxy")}
                  </span>
                </TooltipTrigger>
                <TooltipContent
                  side="top"
                  align="end"
                  className="max-w-[420px]"
                >
                  {t("cluster", "throughProxyHint")}
                </TooltipContent>
              </Tooltip>
              <span>·</span>
            </>
          )}
          {signInHint && (
            <>
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="cursor-default text-warn">
                    {t("cluster", "renewalNeedsYou")}
                  </span>
                </TooltipTrigger>
                <TooltipContent
                  side="top"
                  align="end"
                  className="max-w-[420px]"
                >
                  {t("cluster", signInHint)}
                </TooltipContent>
              </Tooltip>
              <span>·</span>
            </>
          )}
          <Tooltip>
            <TooltipTrigger asChild>
              <span
                data-testid="scope-counts"
                className="flex cursor-default items-center gap-1.5"
              >
                {here === null ? (
                  // Refused, failed or still reading: the count is unknown,
                  // and "0 pods · 0 problems" would say the opposite of the
                  // Overview page's own "no access".
                  <span className="text-fg-fnt">
                    {t("cluster", "countsUnread")}
                  </span>
                ) : (
                  <>
                    {here.pods !== null && (
                      <>
                        <span>
                          {t("cluster", "podCount", { n: here.pods })}
                        </span>
                        <span>·</span>
                      </>
                    )}
                    <ProblemCount attention={here.attention} />
                  </>
                )}
                <span className="text-fg-fnt">
                  {scope.length === 0
                    ? t("cluster", "countsInAll")
                    : scope.length > 2
                      ? t("cluster", "countsInMany", { n: scope.length })
                      : t("cluster", "countsIn", {
                          scope: scopeLabel(scope, t),
                        })}
                </span>
              </span>
            </TooltipTrigger>
            <TooltipContent side="top" align="end" className="max-w-[320px]">
              <ClusterWide />
            </TooltipContent>
          </Tooltip>
        </>
      ) : (
        <span>{t("cluster", "notConnectedLower")}</span>
      )}
    </footer>
  );
}

/** The count the Overview's panel heads, in the colour of its worst row. */
function ProblemCount({ attention }: { attention: Attention }) {
  const t = useT();
  const { total, complete, worst } = attention;
  return (
    <span
      className={cn(
        worst === "err" && "text-err",
        worst === "warn" && "text-warn"
      )}
    >
      {attentionWords({ total, complete }, t)}
    </span>
  );
}

const WHOLE_CLUSTER: readonly string[] = [];

/**
 * The cluster-wide figure, read only while the tooltip is open: the same
 * attention the Overview counts, for every namespace instead of the scope.
 * Not asked at all once the whole cluster refused this connection.
 */
function ClusterWide() {
  const t = useT();
  const { podCount, refused } = useClusterSummary();
  if (refused || podCount === null)
    return <>{t("cluster", "clusterWideUnread")}</>;
  return <ClusterWideCounts podCount={podCount} />;
}

function ClusterWideCounts({ podCount }: { podCount: number }) {
  const t = useT();
  const attention = useAttention({ scope: WHOLE_CLUSTER });
  return (
    <>
      {t("cluster", "clusterWideCounts", {
        pods: t("cluster", "podCount", { n: podCount }),
        problems: attention
          ? attentionWords(attention, t)
          : t("cluster", "countsUnread"),
      })}
    </>
  );
}

const THEMES = [
  { value: "light", k: "themeLight", icon: Sun },
  { value: "dark", k: "themeDark", icon: Moon },
  { value: "system", k: "themeSystem", icon: Monitor },
] as const;

function ThemeControl() {
  const t = useT();
  const theme = useThemeStore((s) => s.theme);
  const setTheme = useThemeStore((s) => s.setTheme);
  const current = THEMES.find((t) => t.value === theme) ?? THEMES[2];
  const Icon = current.icon;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={t("settings", "themeNamed", {
            theme: t("settings", current.k),
          })}
          className="flex items-center gap-1.5 rounded px-1.5 text-[11px] text-fg-fnt transition-colors hover:text-fg"
        >
          <Icon className="h-3 w-3" />
          {t("settings", current.k).toLowerCase()}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" side="top">
        {THEMES.map((option) => (
          <DropdownMenuItem
            key={option.value}
            onClick={() => setTheme(option.value)}
          >
            <option.icon className="mr-2 h-4 w-4" />
            {t("settings", option.k)}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
