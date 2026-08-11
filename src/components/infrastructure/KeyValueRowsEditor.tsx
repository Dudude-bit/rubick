/**
 * Shared key/value pair editor used by InspectorPanel for labels,
 * selectors, configmap data, and secret data — four near-identical
 * blocks that previously lived inline as ~50 LOC each.
 *
 * The component owns no state — `rows` and `onChange` are caller-
 * owned so the parent stays the source of truth (it commits the
 * rows back to the node on every keystroke via its `onUpdate`).
 */

import { Trash2, Plus } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export interface KeyValueRow {
  key: string;
  value: string;
}

interface KeyValueRowsEditorProps {
  rows: KeyValueRow[];
  /** Called with the new row list on every key/value/add/remove. */
  onChange: (next: KeyValueRow[]) => void;
  /** Used for the "Add" button text and aria-context (e.g. "label"). */
  itemLabel: string;
  /** Optional placeholder for the value input — useful when the
   *  value is the visible thing (secrets/configmap data). */
  valuePlaceholder?: string;
  /** Optional placeholder for the key input. Defaults to "key". */
  keyPlaceholder?: string;
}

export function KeyValueRowsEditor({
  rows,
  onChange,
  itemLabel,
  keyPlaceholder = "key",
  valuePlaceholder = "value",
}: KeyValueRowsEditorProps) {
  const updateRow = (index: number, patch: Partial<KeyValueRow>) => {
    const next = rows.map((item, idx) =>
      idx === index ? { ...item, ...patch } : item
    );
    onChange(next);
  };

  const removeRow = (index: number) => {
    onChange(rows.filter((_, idx) => idx !== index));
  };

  const addRow = () => {
    onChange([...rows, { key: "", value: "" }]);
  };

  return (
    <div className="space-y-1">
      {rows.map((row, index) => (
        <div key={`${row.key}-${index}`} className="flex items-center gap-1">
          <Input
            placeholder={keyPlaceholder}
            value={row.key}
            onChange={(event) => updateRow(index, { key: event.target.value })}
          />
          <Input
            placeholder={valuePlaceholder}
            value={row.value}
            onChange={(event) =>
              updateRow(index, { value: event.target.value })
            }
          />
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={`Remove ${itemLabel}`}
            onClick={() => removeRow(index)}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      ))}
      <Button type="button" variant="ghost" size="sm" onClick={addRow}>
        <Plus className="mr-1.5 h-3 w-3" aria-hidden="true" />
        Add {itemLabel}
      </Button>
    </div>
  );
}
