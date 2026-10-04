import { useRouter } from "@tanstack/react-router";

import { EmptyPage } from "@/components/layout/NotFound";
import { ResourceDetailHeader } from "./ResourceDetailHeader";
import { YamlTabContent } from "./YamlTabContent";
import { useCopyToClipboard } from "@/hooks/useCopyToClipboard";
import { useResourceYaml } from "@/hooks/useResourceYaml";
import { useT } from "@/i18n/useT";
import { errorToShow } from "@/lib/error-utils";
import type { ResourceKind } from "@/lib/resource-registry";

/**
 * An object of a kind the registry knows and no screen draws: what it says
 * about itself, as YAML. A read that failed says so in the cluster's words;
 * it is never drawn as an object that is not there.
 */
export function GenericObjectPage({
  kind,
  namespace,
  name,
}: {
  kind: ResourceKind;
  namespace?: string;
  name: string;
}) {
  const t = useT();
  const router = useRouter();
  const copy = useCopyToClipboard();
  const yaml = useResourceYaml(kind, name, namespace, "yaml");

  return (
    <div className="flex h-full flex-col gap-4">
      <ResourceDetailHeader
        kind={kind}
        name={name}
        namespace={namespace}
        onBack={() => router.history.back()}
      />
      {yaml.isError ? (
        <EmptyPage
          title={t("empty", "objectUnread")}
          body={errorToShow(yaml.error)}
        />
      ) : (
        <YamlTabContent
          yaml={yaml.data}
          resourceKind={kind}
          resourceName={name}
          namespace={namespace}
          onCopy={() => yaml.data && copy(yaml.data)}
        />
      )}
    </div>
  );
}
