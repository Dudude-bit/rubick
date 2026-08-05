import * as React from "react";
import { Loader2, Plus, TestTube, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";

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
  isEmpty,
  emptyMessage,
  children,
}: {
  title: string;
  addLabel: string;
  onAdd: () => void;
  isLoading: boolean;
  isEmpty: boolean;
  emptyMessage: string;
  children: React.ReactNode;
}) {
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
        <p className="py-2 text-[11px] text-fg-mut">Loading…</p>
      ) : isEmpty ? (
        <p className="py-2 text-[11px] text-fg-mut">{emptyMessage}</p>
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
  onEdit,
  onDelete,
  busy,
}: {
  name: string;
  /** A short qualifier shown beside the name, e.g. the auth mechanism. */
  detail?: React.ReactNode;
  description?: React.ReactNode;
  onTest?: () => void;
  onEdit: () => void;
  onDelete: () => void;
  busy?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-4 rounded px-1 py-1 transition-colors hover:bg-hover">
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="flex items-center gap-2">
          <span className="truncate font-mono text-xs text-fg">{name}</span>
          {detail && <span className="text-[11px] text-fg-fnt">{detail}</span>}
        </span>
        {description && (
          <span className="truncate text-[11px] text-fg-mut">
            {description}
          </span>
        )}
      </div>
      <div className="flex flex-none items-center gap-0.5">
        {onTest && (
          <Button
            size="icon"
            variant="ghost"
            aria-label={`Test ${name}`}
            onClick={onTest}
            disabled={busy}
          >
            {busy ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <TestTube className="h-3.5 w-3.5" />
            )}
          </Button>
        )}
        <Button size="sm" variant="ghost" onClick={onEdit}>
          Edit
        </Button>
        <Button
          size="icon"
          variant="ghost"
          aria-label={`Delete ${name}`}
          onClick={onDelete}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  );
}
