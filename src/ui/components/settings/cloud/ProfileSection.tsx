import * as React from "react";
import { Plus, TestTube, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { Unknown } from "@/components/ui/unknown";
import { useT } from "@/i18n/useT";

/**
 * The GCP and Azure profile lists are the same screen with different
 * fields, so they share one shape here rather than two near-identical
 * copies of the markup. Each profile is a hairline row, not a bordered
 * card: a list of five profiles was a stack of five boxes.
 */
export function ProfileSection({
  title,
  addLabel,
  onAdd,
  isLoading,
  error,
  onRetry,
  isEmpty,
  emptyMessage,
  children,
}: {
  title: string;
  addLabel: string;
  onAdd: () => void;
  isLoading: boolean;
  /** The list could not be read; it is never drawn as "no profiles". */
  error?: unknown;
  onRetry?: () => unknown;
  isEmpty: boolean;
  emptyMessage: string;
  children: React.ReactNode;
}) {
  const t = useT();
  return (
    <div className="border-b border-hair py-2 last:border-b-0">
      <div className="flex items-center justify-between gap-4">
        <h3 className="text-xs font-medium text-fg-mid">{title}</h3>
        <Button variant="ghost" size="sm" onClick={onAdd}>
          <Plus className="mr-1.5 h-3 w-3" aria-hidden="true" />
          {addLabel}
        </Button>
      </div>
      {isLoading ? (
        <div
          role="status"
          aria-label={t("action", "reading")}
          className="mt-1 space-y-2 py-1"
        >
          <Skeleton className="h-3 w-48" />
          <Skeleton className="h-3 w-32" />
        </div>
      ) : error ? (
        <Unknown
          className="mt-1"
          question={t("settings", "profilesUnread")}
          error={error}
          onRetry={onRetry}
        />
      ) : isEmpty ? (
        <p className="py-2 text-caption text-fg-mut">{emptyMessage}</p>
      ) : (
        <div className="mt-1">{children}</div>
      )}
    </div>
  );
}

export function ProfileRow({
  name,
  detail,
  description,
  onTest,
  testing,
  onEdit,
  onDelete,
  busy,
}: {
  name: string;
  /** A short qualifier shown beside the name, e.g. the auth mechanism. */
  detail?: React.ReactNode;
  description?: React.ReactNode;
  onTest?: () => void;
  testing?: boolean;
  onEdit: () => void;
  /** A promise keeps the confirmation open and pending until the delete settles. */
  onDelete: () => unknown;
  /** Some action on this profile is running: none of them can be pressed again. */
  busy?: boolean;
}) {
  const t = useT();
  const [confirming, setConfirming] = React.useState(false);
  return (
    <div className="flex items-center justify-between gap-4 rounded px-1 py-1 transition-colors hover:bg-hover">
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="flex items-center gap-2">
          <span className="truncate font-mono text-xs text-fg">{name}</span>
          {detail && <span className="text-caption text-fg-fnt">{detail}</span>}
        </span>
        {description && (
          <span className="truncate text-caption text-fg-mut">
            {description}
          </span>
        )}
      </div>
      <div className="flex flex-none items-center gap-0.5">
        {onTest && (
          <Button
            size="icon"
            variant="ghost"
            aria-label={t("settings", "testNamed", { name })}
            onClick={onTest}
            pending={testing}
            disabled={busy}
          >
            <TestTube className="h-3.5 w-3.5" />
          </Button>
        )}
        <Button variant="ghost" onClick={onEdit} disabled={busy}>
          {t("settings", "edit")}
        </Button>
        <Button
          size="icon"
          variant="ghost"
          aria-label={t("settings", "deleteNamed", { name })}
          onClick={() => setConfirming(true)}
          disabled={busy}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      </div>
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={t("settings", "deleteProfileTitle", { name })}
        description={t("settings", "deleteProfileBody")}
        confirmLabel={t("action", "delete")}
        confirmVariant="destructive"
        onConfirm={onDelete}
      />
    </div>
  );
}
