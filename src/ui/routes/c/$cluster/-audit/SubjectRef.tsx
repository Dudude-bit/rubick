import { Package } from "lucide-react";

import { ResourceRef } from "@/components/object/ResourceRef";
import { RouteLink } from "@/components/ui/route-link";
import type { Subject } from "@/generated/types";
import { useT } from "@/i18n/useT";
import { helmOwnerLink } from "@/lib/helm-owner";
import { HELM_RELEASE } from "./rules";

/**
 * An audited object, linked where it lives: a Helm release to its release
 * page, which has no peek, and every other kind through `ResourceRef`.
 */
export function SubjectRef({
  subject,
  showNamespace = true,
}: {
  subject: Subject;
  /** Off where a column beside it already says the namespace. */
  showNamespace?: boolean;
}) {
  const t = useT();
  if (subject.kind === HELM_RELEASE && subject.namespace) {
    return (
      <RouteLink
        {...helmOwnerLink({
          name: subject.name,
          namespace: subject.namespace,
        })}
        menuName={subject.name}
        className="inline-flex min-w-0 items-center gap-1.5 text-fg hover:underline"
      >
        <Package className="h-3 w-3 shrink-0 text-fg-fnt" aria-hidden />
        <span className="text-fg-mut">{t("audit", "helmRelease")}</span>
        <span className="truncate font-mono">
          {showNamespace && (
            <span className="text-fg-fnt">{subject.namespace}/</span>
          )}
          {subject.name}
        </span>
      </RouteLink>
    );
  }
  return (
    <ResourceRef
      kind={subject.kind}
      name={subject.name}
      namespace={subject.namespace ?? undefined}
      showNamespace={showNamespace}
    />
  );
}
