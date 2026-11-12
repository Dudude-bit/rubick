import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { KeyValueRow } from "../../../-object/detail-kv";
import type { HelmRelease } from "@/generated/types";
import { useCriticalGate } from "@/hooks/useCriticalGate";
import { useT } from "@/i18n/useT";
import { WITHHELD_MARKER } from "@/lib/withheld";

export interface HelmUpgradeDialogProps {
  /** Release to upgrade */
  release: HelmRelease | null;
  /** Close the dialog */
  onClose: () => void;
  /** Where helm gets the chart: the release itself does not say. */
  chart: string;
  onChartChange: (chart: string) => void;
  /** Version */
  version: string;
  onVersionChange: (version: string) => void;
  /** Values YAML */
  values: string;
  onValuesChange: (values: string) => void;
  /** Wait for ready flag */
  wait: boolean;
  onWaitChange: (wait: boolean) => void;
  /** Upgrade handler */
  onUpgrade: () => void;
  /** Whether upgrade is in progress */
  isUpgrading: boolean;
}

export function HelmUpgradeDialog({
  release,
  onClose,
  chart,
  onChartChange,
  version,
  onVersionChange,
  values,
  onValuesChange,
  wait,
  onWaitChange,
  onUpgrade,
  isUpgrading,
}: HelmUpgradeDialogProps) {
  const t = useT();
  // Upgrading replaces a release on the cluster, so on a critical one it takes
  // the typed-name gate — as uninstall and rollback already do.
  const gate = useCriticalGate(release !== null);
  // Values copied off the Values tab: helm would store the placeholder as
  // the key. The backend refuses the same text.
  const carriesWithheld = values.includes(WITHHELD_MARKER);

  return (
    <Dialog open={release !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("action", "upgradeRelease")}</DialogTitle>
          <DialogDescription>
            {t("action", "upgradeReleaseIn", {
              name: release?.name ?? "",
              namespace: release?.namespace ?? "",
            })}
          </DialogDescription>
          {gate.notice}
        </DialogHeader>
        <div className="space-y-4 py-4">
          <dl className="max-w-sm">
            <KeyValueRow label={t("action", "currentChart")} mono>
              {release?.chart}
            </KeyValueRow>
            <KeyValueRow label={t("action", "revision")} mono>
              {release?.revision}
            </KeyValueRow>
          </dl>
          <div className="space-y-2">
            <Label htmlFor="upgrade-chart">{t("action", "upgradeChart")}</Label>
            <Input
              id="upgrade-chart"
              value={chart}
              onChange={(e) => onChartChange(e.target.value)}
              placeholder="repo/chart"
              autoComplete="off"
            />
            <p className="text-[11px] text-fg-fnt">
              {t("action", "upgradeChartHint")}
            </p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="upgrade-version">
              {t("action", "newVersionOptional")}
            </Label>
            <Input
              id="upgrade-version"
              value={version}
              onChange={(e) => onVersionChange(e.target.value)}
              placeholder={t("action", "leaveEmptyForLatest")}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="upgrade-values">
              {t("action", "valuesYamlOptional")}
            </Label>
            <Textarea
              id="upgrade-values"
              value={values}
              onChange={(e) => onValuesChange(e.target.value)}
              placeholder={t("action", "valuesPlaceholder")}
              className="font-mono text-sm h-32"
            />
            {carriesWithheld && (
              <p role="status" className="text-xs text-warn">
                {t("action", "helmUpgradeCarriesWithheld")}
              </p>
            )}
          </div>
          <div className="flex items-center gap-2">
            <Checkbox
              id="upgrade-wait"
              checked={wait}
              onCheckedChange={(checked) => onWaitChange(checked === true)}
            />
            <Label htmlFor="upgrade-wait" className="text-sm">
              {t("action", "waitForReady")}
            </Label>
          </div>
          {gate.input}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t("action", "cancel")}
          </Button>
          <Button
            onClick={onUpgrade}
            disabled={
              isUpgrading ||
              gate.blocked ||
              chart.trim() === "" ||
              carriesWithheld
            }
          >
            {isUpgrading ? t("action", "upgrading") : t("action", "upgrade")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
