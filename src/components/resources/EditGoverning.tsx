import { YamlEditorAction } from "@/components/yaml";
import { fetchResourceYaml } from "@/hooks/useResourceYaml";
import { useT } from "@/i18n/useT";

/**
 * The way into an autoscaler or a budget. Neither kind has a page (it is a
 * property of the workload, not a thing to browse), so the workload's
 * block is where a reader who wants to change one has to find the editor.
 */
export function EditGoverning({
  object,
}: {
  object: { kind: string; name: string; namespace?: string | null };
}) {
  const t = useT();
  const namespace = object.namespace ?? undefined;
  return (
    <YamlEditorAction
      title={t("action", "editResourceTitle", {
        kind: object.kind,
        name: object.name,
      })}
      resourceKey={{ kind: object.kind, name: object.name, namespace }}
      fetchYaml={() => fetchResourceYaml(object.kind, object.name, namespace)}
      className="ml-1.5 h-5 px-1.5 text-[11px]"
    />
  );
}
