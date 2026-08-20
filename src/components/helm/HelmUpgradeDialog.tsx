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
import { KeyValueRow } from "@/components/resources/detail-kv";
import type { HelmRelease } from "@/generated/types";
import { useT } from "@/i18n/useT";

export interface HelmUpgradeDialogProps {
  /** Release to upgrade */
  release: HelmRelease | null;
  /** Close the dialog */
  onClose: () => void;
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
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t("action", "cancel")}
          </Button>
          <Button onClick={onUpgrade} disabled={isUpgrading}>
            {isUpgrading ? t("action", "upgrading") : t("action", "upgrade")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
