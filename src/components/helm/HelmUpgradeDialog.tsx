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
  return (
    <Dialog open={release !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Upgrade Release</DialogTitle>
          <DialogDescription>
            Upgrade {release?.name} in namespace {release?.namespace}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-4">
          <dl className="max-w-sm">
            <KeyValueRow label="Current chart" mono>
              {release?.chart}
            </KeyValueRow>
            <KeyValueRow label="Revision" mono>
              {release?.revision}
            </KeyValueRow>
          </dl>
          <div className="space-y-2">
            <Label htmlFor="upgrade-version">New Version (optional)</Label>
            <Input
              id="upgrade-version"
              value={version}
              onChange={(e) => onVersionChange(e.target.value)}
              placeholder="Leave empty for latest"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="upgrade-values">Values (YAML, optional)</Label>
            <Textarea
              id="upgrade-values"
              value={values}
              onChange={(e) => onValuesChange(e.target.value)}
              placeholder="# Custom values to merge&#10;replicaCount: 3"
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
              Wait for ready
            </Label>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={onUpgrade} disabled={isUpgrading}>
            {isUpgrading ? "Upgrading..." : "Upgrade"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
