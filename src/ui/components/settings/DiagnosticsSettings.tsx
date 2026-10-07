import { keepPreviousData } from "@tanstack/react-query";
import { copyText } from "@/lib/host";
import { ClipboardCopy } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { useToast } from "@/components/ui/use-toast";
import { useLiveQuery } from "@/hooks/useLiveQuery";
import { commands } from "@/lib/commands";
import { EnvironmentBlocks } from "./diagnostics/EnvironmentBlocks";
import { FindingsList } from "./diagnostics/FindingsList";
import { PerformancePanel } from "./diagnostics/PerformancePanel";
import { asMarkdown } from "./diagnostics/report";
import { useT } from "@/i18n/useT";
import { usePrivacyStore } from "@/stores/privacyStore";

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
  // the reader opened stay open; it is never what Copy hands over.
  const { data, isPlaceholderData } = useLiveQuery({
    queryKey: ["diagnostics", redact],
    queryFn: () => commands.collectDiagnostics(redact),
    placeholderData: keepPreviousData,
    refresh: "slow",
  });
  const asked = isPlaceholderData ? undefined : data;

  return (
    <div className="max-w-[76ch] py-2">
      <FindingsList findings={data?.findings ?? []} shell={data?.shell} />

      {data && <EnvironmentBlocks diagnostics={data} />}

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

        <label className="flex items-center gap-2 text-xs text-fg-mut">
          <Checkbox
            checked={redact}
            onCheckedChange={(next) => setRedact(next === true)}
            aria-label={t("settings", "redactNamesAndPaths")}
          />
          {t("settings", "redactNamesAndPaths")}
        </label>
      </div>
      <p className="mt-1.5 text-[11px] text-fg-fnt">
        {t("settings", "redactEverywhere")}
      </p>

      <PerformancePanel />
    </div>
  );
}
