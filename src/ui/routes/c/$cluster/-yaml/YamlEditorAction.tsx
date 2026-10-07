/**
 * The button that opens the YAML editor. Its own file, apart from the dialog:
 * the button is on every detail page at startup, and the dialog — with the
 * YAML parser it needs — loads when it is first opened.
 */

import { FileJson } from "lucide-react";

import { useToast } from "@/components/ui/use-toast";
import { ReasonedAction } from "@/components/object/detail-blocks";
import { useEditDenied } from "../-object/access";
import { errorToShow } from "@/lib/error-utils";
import { useYamlEditorStore, type ResourceKey } from "@/stores/yamlEditorStore";
import { useT } from "@/i18n/useT";

interface YamlEditorActionProps {
  title: string;
  resourceKey: ResourceKey;
  fetchYaml: () => Promise<string>;
  menuLabel?: string;
  readOnly?: boolean;
  className?: string;
}

/** Open it, and say why if it will not open. Shared by both affordances. */
function useOpenEditor({
  title,
  resourceKey,
  fetchYaml,
  readOnly = false,
}: YamlEditorActionProps) {
  const t = useT();
  const { toast } = useToast();
  const openEditor = useYamlEditorStore((state) => state.openEditor);

  return async () => {
    try {
      await openEditor({ title, resourceKey, fetchYaml, readOnly });
    } catch (error) {
      toast({
        title: t("empty", "couldNotReadManifest"),
        description: errorToShow(error),
        variant: "destructive",
      });
    }
  };
}

const editorLabel = (
  t: ReturnType<typeof useT>,
  { menuLabel, readOnly }: YamlEditorActionProps
) => menuLabel ?? t("action", readOnly ? "viewYaml" : "editYaml");

// Button-based action for use in headers/toolbars
export function YamlEditorAction(props: YamlEditorActionProps) {
  const t = useT();
  const open = useOpenEditor(props);
  const denied = useEditDenied(props.readOnly ? null : props.resourceKey);
  return (
    <ReasonedAction
      label={editorLabel(t, props)}
      icon={FileJson}
      onClick={open}
      className={props.className}
      reason={denied}
    />
  );
}
