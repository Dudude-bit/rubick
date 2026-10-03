import { TextSkeleton } from "@/components/ui/skeleton";
import { YamlEditor, YamlEditorAction } from "@/components/yaml";
import { fetchResourceYaml } from "@/hooks/useResourceYaml";
import { Copy } from "lucide-react";
import { useCallback } from "react";

import { DetailAction } from "./detail-blocks";
import { useT } from "@/i18n/useT";

export interface YamlTabContentProps {
  /**
   * The pane's accessible name. Deliberately not drawn: the breadcrumb, the
   * page header and the tab strip have each already named this object, and
   * line 2 of the document says its kind. Kept as the label a screen reader
   * gets for the region, which is the one place the name is not a repeat.
   */
  title?: string;
  yaml: string | undefined;
  onCopy: () => void;
  /** What the document is. One line, in the reader's terms, not the API's. */
  note?: string;
  /**
   * The live object behind the text. Without one there is nothing to edit —
   * a rendered Helm manifest is not something the API server will take back —
   * and the edit action is left off rather than shown dead.
   */
  resourceKind?: string;
  resourceName?: string;
  namespace?: string;
}

export function YamlTabContent({
  title,
  yaml,
  resourceKind,
  resourceName,
  namespace,
  note,
  onCopy,
}: YamlTabContentProps) {
  const t = useT();
  const isYamlLoading = yaml == null;

  const handleFetchYaml = useCallback(() => {
    return fetchResourceYaml(resourceKind ?? "", resourceName ?? "", namespace);
  }, [resourceKind, resourceName, namespace]);

  return (
    <section aria-label={title} className="flex h-full flex-col">
      {/* A section header without the heading: the actions keep the row and
          the rhythm, and the line the title used to occupy says something
          the reader did not already know. */}
      <div className="flex flex-none items-center gap-2 pb-2">
        <p className="text-[11px] text-fg-fnt">
          {note ?? t("empty", "yamlNoteDefault")}
        </p>
        <div className="ml-auto flex items-center gap-1">
          {resourceKind && resourceName && (
            <YamlEditorAction
              title={t("action", "editResourceTitle", {
                kind: resourceKind,
                name: resourceName,
              })}
              resourceKey={{
                kind: resourceKind,
                name: resourceName,
                namespace: namespace,
              }}
              fetchYaml={handleFetchYaml}
            />
          )}
          <DetailAction
            label={t("action", "copy")}
            icon={Copy}
            onClick={onCopy}
            disabled={isYamlLoading}
          />
        </div>
      </div>
      {isYamlLoading ? (
        <div className="min-h-0 flex-1 overflow-hidden border-t border-hair p-4">
          <TextSkeleton lines={18} />
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-hidden border-t border-hair">
          {/* The editor scrolls itself, so it is handed the box rather than a
              number: a manifest is read against the window it is read in. */}
          <YamlEditor value={yaml} readOnly height="100%" />
        </div>
      )}
    </section>
  );
}
