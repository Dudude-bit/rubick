import { Button } from "@/components/ui/button";
import { SectionHeader } from "@/components/ui/section";
import { TextSkeleton } from "@/components/ui/skeleton";
import { YamlEditor, YamlEditorAction } from "@/components/yaml";
import { fetchResourceYaml } from "@/hooks/useResourceYaml";
import { Copy } from "lucide-react";
import { useCallback } from "react";

export interface YamlTabContentProps {
  title: string;
  yaml: string | undefined;
  resourceKind: string;
  resourceName: string;
  namespace: string | undefined;
  onCopy: () => void;
}

export function YamlTabContent({
  title,
  yaml,
  resourceKind,
  resourceName,
  namespace,
  onCopy,
}: YamlTabContentProps) {
  const isYamlLoading = yaml == null;

  const handleFetchYaml = useCallback(() => {
    return fetchResourceYaml(resourceKind, resourceName, namespace);
  }, [resourceKind, resourceName, namespace]);

  return (
    <div className="flex h-full flex-col">
      <SectionHeader
        className="flex-none pb-2"
        title={title}
        actions={
          <>
            <YamlEditorAction
              title={`Edit ${resourceKind}: ${resourceName}`}
              resourceKey={{
                kind: resourceKind,
                name: resourceName,
                namespace: namespace,
              }}
              fetchYaml={handleFetchYaml}
            />
            <Button variant="outline" size="sm" onClick={onCopy}>
              <Copy className="mr-2 h-4 w-4" />
              Copy
            </Button>
          </>
        }
      />
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
    </div>
  );
}
