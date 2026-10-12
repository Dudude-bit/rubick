import { Lock } from "lucide-react";

import { ResourceRef } from "@/components/object/ResourceRef";
import { useT } from "@/i18n/useT";
import { isRefusal } from "@/lib/error-utils";
import { ResourceType } from "@/lib/resource-registry";
import { useNodeRead } from "./useNodeRead";

/** A link to a node, padlocked where the reader may not read it: its page would only say so. */
export function NodeRef({
  name,
  className,
}: {
  name: string;
  className?: string;
}) {
  const t = useT();
  const read = useNodeRead(name);
  const refused = read.isError && isRefusal(read.error);
  const words = t("readings", "refusedToRead", {
    kind: ResourceType.Node,
    name,
  });
  return (
    <span className="inline-flex min-w-0 items-baseline gap-1">
      <ResourceRef
        kind={ResourceType.Node}
        name={name}
        showKind={false}
        className={className}
      />
      {refused && (
        <Lock
          className="h-3 w-3 flex-none self-center text-fg-fnt"
          aria-label={words}
          data-testid="node-refused"
        >
          <title>{words}</title>
        </Lock>
      )}
    </span>
  );
}
