import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/components/ui/use-toast";
import { SettingRow, SettingsGroup } from "@/components/settings/settings-row";
import { commands } from "@/lib/commands";
import { errorToShow } from "@/lib/error-utils";
import { formatBytes } from "@/lib/k8s-quantity";
import { queryKeys } from "@/lib/query-keys";
import { useT } from "@/i18n/useT";

/**
 * What the app keeps on this machine besides its settings: the timeline of
 * every cluster it watched, with the switch that stops keeping it and the
 * button that forgets it.
 */
export function KeptPanel() {
  const t = useT();
  const { toast } = useToast();
  const client = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const kept = useQuery({
    queryKey: queryKeys.timelineKept(),
    queryFn: () => commands.timelineKept(),
    refetchOnWindowFocus: false,
  });
  const keep = kept.data?.keep;
  // Every surface reads what is kept afresh: it says now whether it is.
  const told = () =>
    Promise.all([
      client.invalidateQueries({ queryKey: queryKeys.timelineKept() }),
      client.invalidateQueries({ queryKey: ["timeline"] }),
    ]);

  const setKeep = async (next: boolean) => {
    try {
      await commands.timelineSetKeep(next);
    } finally {
      await told();
    }
  };
  const clear = async () => {
    try {
      await commands.timelineClear();
      toast({ title: t("settings", "timelineCleared") });
    } catch (error) {
      toast({
        title: t("settings", "timelineNotCleared", {
          reason: errorToShow(error),
        }),
        variant: "destructive",
      });
    } finally {
      await told();
    }
  };

  const size = kept.data
    ? kept.data.bytes > 0
      ? t("settings", "keptSize", {
          size: formatBytes(kept.data.bytes),
          clusters: t("count", "keptClusters", { n: kept.data.clusters }),
        })
      : t("settings", "keptNothing")
    : kept.error
      ? t("settings", "keptUnread", { reason: errorToShow(kept.error) })
      : null;

  return (
    <SettingsGroup title={t("settings", "keptTitle")} className="mt-6">
      <SettingRow
        label={t("settings", "keepTimeline")}
        hint={t("settings", "keepTimelineHint")}
        control={
          <Switch
            aria-label={t("settings", "keepTimeline")}
            checked={keep ?? false}
            disabled={keep === undefined}
            onCheckedChange={(next) => void setKeep(next)}
          />
        }
      />
      <SettingRow
        label={t("settings", "clearTimeline")}
        hint={
          <span data-testid="kept-size">
            {[size, keep === false ? t("settings", "keptOff") : null]
              .filter(Boolean)
              .join(" ")}
          </span>
        }
        control={
          <Button
            variant="outline"
            size="sm"
            onClick={() => setConfirming(true)}
          >
            {t("settings", "clearTimeline")}
          </Button>
        }
      />
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={t("settings", "clearTimeline")}
        description={t("settings", "clearTimelineConfirm")}
        confirmLabel={t("settings", "clearTimeline")}
        confirmVariant="destructive"
        onConfirm={() => {
          setConfirming(false);
          void clear();
        }}
      />
    </SettingsGroup>
  );
}
