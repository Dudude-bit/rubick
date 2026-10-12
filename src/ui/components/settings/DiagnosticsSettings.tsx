import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { copyText } from "@/lib/host";
import { CircleX, ClipboardCopy, RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/components/ui/use-toast";
import { commands } from "@/lib/commands";
import { errorToShow } from "@/lib/error-utils";
import { EnvironmentBlocks } from "./diagnostics/EnvironmentBlocks";
import { FindingsList } from "./diagnostics/FindingsList";
import { PerformancePanel } from "./diagnostics/PerformancePanel";
import { asMarkdown } from "./diagnostics/report";
import { useT } from "@/i18n/useT";
import { cn, formatWhen } from "@/lib/utils";
import { usePrivacyStore } from "@/stores/privacyStore";

const ENVIRONMENT_BLOCKS = 7;

/** The environment blocks' height while the machine is read, so nothing below moves under the pointer when they land. */
function Reading() {
  const t = useT();
  return (
    <div data-testid="diagnostics-reading">
      <p className="min-h-12 max-w-[72ch] text-xs text-fg-mut">
        {t("settings", "diagnosticsReading")}
      </p>
      <div className="mt-6" aria-hidden="true">
        {Array.from({ length: ENVIRONMENT_BLOCKS }, (_, index) => (
          <div key={index} className="border-t border-hair py-3">
            <div className="flex h-4 items-center">
              <Skeleton className="h-2.5 w-36" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * What the app can see of this machine.
 *
 * Reads redacted by default. The button beside it copies exactly what was
 * read, and a report that carries an employer's internal hostnames into a
 * public issue tracker is the failure this default exists to prevent — the
 * person pasting is thinking about their bug, not about their employer.
 */
export function DiagnosticsSettings() {
  const t = useT();
  const redact = usePrivacyStore((state) => state.hidePaths);
  const setRedact = usePrivacyStore((state) => state.setHidePaths);
  const { toast } = useToast();

  // The other read stays on screen while this one loads, so the sections
  // the reader opened stay open; it is never what Copy hands over. Read on
  // open and on request: on a timer it cost a quarter second every eight,
  // inside the numbers of any recording taken from this page.
  const { data, isPlaceholderData, error, isFetching, dataUpdatedAt, refetch } =
    useQuery({
      queryKey: ["diagnostics", redact],
      queryFn: () => commands.collectDiagnostics(redact),
      placeholderData: keepPreviousData,
      refetchOnWindowFocus: false,
    });
  const asked = isPlaceholderData ? undefined : data;

  return (
    <div className="max-w-[76ch] py-2">
      {data ? (
        <>
          <FindingsList findings={data.findings} shell={data.shell} />
          <EnvironmentBlocks diagnostics={data} />
        </>
      ) : error ? (
        <div className="text-xs" data-testid="diagnostics-unread">
          <p className="flex items-center gap-1.5 text-err">
            <CircleX className="h-3.5 w-3.5 flex-none" aria-hidden="true" />
            {t("settings", "diagnosticsUnread")}
          </p>
          <p className="mt-1 select-text wrap-break-word font-mono text-[11px] text-fg-fnt">
            {errorToShow(error)}
          </p>
        </div>
      ) : (
        <Reading />
      )}

      <div className="mt-6 flex items-center gap-4 border-t border-hair pt-4">
        <Button
          variant="outline"
          size="sm"
          disabled={!asked}
          onClick={async () => {
            if (!asked) return;
            await copyText(asMarkdown(asked));
            toast({ title: t("settings", "diagnosticsCopied") });
          }}
        >
          <ClipboardCopy className="mr-1.5 h-3.5 w-3.5" />
          {t("settings", "copyDiagnostics")}
        </Button>

        <Button
          variant="outline"
          size="sm"
          disabled={isFetching}
          onClick={() => void refetch()}
        >
          <RefreshCw
            className={`mr-1.5 h-3.5 w-3.5 ${isFetching ? "animate-spin" : ""}`}
            aria-hidden="true"
          />
          {t("settings", "readDiagnosticsAgain")}
        </Button>

        <label className="flex items-center gap-2 text-xs text-fg-mut">
          <Checkbox
            checked={redact}
            onCheckedChange={(next) => setRedact(next === true)}
            aria-label={t("settings", "redactNamesAndPaths")}
          />
          {t("settings", "redactNamesAndPaths")}
        </label>

        {asked && (
          <span
            className={cn(
              "ml-auto flex items-center gap-1 text-[11px] tabular-nums",
              error ? "text-err" : "text-fg-fnt"
            )}
          >
            {error && (
              <CircleX className="h-3 w-3 flex-none" aria-hidden="true" />
            )}
            {t(
              "settings",
              error ? "diagnosticsReadAgainFailed" : "diagnosticsReadAt",
              { at: formatWhen(dataUpdatedAt, "clock") }
            )}
          </span>
        )}
      </div>
      <p className="mt-1.5 text-[11px] text-fg-fnt">
        {t("settings", "redactEverywhere")}
      </p>

      <PerformancePanel />
    </div>
  );
}
