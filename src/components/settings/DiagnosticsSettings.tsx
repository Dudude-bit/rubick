import { useState } from "react";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { ClipboardCopy } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { useToast } from "@/components/ui/use-toast";
import { useLiveQuery } from "@/hooks/useLiveQuery";
import { commands } from "@/lib/commands";
import { EnvironmentBlocks } from "./diagnostics/EnvironmentBlocks";
import { FindingsList } from "./diagnostics/FindingsList";
import { asMarkdown } from "./diagnostics/report";

/**
 * What the app can see of this machine.
 *
 * Reads redacted by default. The button beside it copies exactly what was
 * read, and a report that carries an employer's internal hostnames into a
 * public issue tracker is the failure this default exists to prevent — the
 * person pasting is thinking about their bug, not about their employer.
 */
export function DiagnosticsSettings() {
  const [redact, setRedact] = useState(true);
  const { toast } = useToast();

  const { data } = useLiveQuery({
    queryKey: ["diagnostics", redact],
    queryFn: () => commands.collectDiagnostics(redact),
    refresh: "slow",
  });

  return (
    <div className="max-w-[76ch] py-2">
      <FindingsList findings={data?.findings ?? []} />

      {data && <EnvironmentBlocks diagnostics={data} />}

      <div className="mt-6 flex items-center gap-4 border-t border-hair pt-4">
        <Button
          variant="outline"
          size="sm"
          disabled={!data}
          onClick={async () => {
            if (!data) return;
            await writeText(asMarkdown(data));
            toast({ title: "Diagnostics copied" });
          }}
        >
          <ClipboardCopy className="mr-1.5 h-3.5 w-3.5" />
          Copy diagnostics
        </Button>

        <label className="flex items-center gap-2 text-xs text-fg-mut">
          <Checkbox
            checked={redact}
            onCheckedChange={(next) => setRedact(next === true)}
            aria-label="Redact names and paths"
          />
          Redact names and paths
        </label>
      </div>
    </div>
  );
}
