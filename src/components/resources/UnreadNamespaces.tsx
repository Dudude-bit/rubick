import { Unknown } from "@/components/ui/unknown";
import type { UnreadNamespace } from "@/generated/types";
import { useT } from "@/i18n/useT";

/**
 * The namespaces of the scope a list could not read, each with the cluster's
 * own reason: beside the rows of the ones that answered, not folded into
 * "there are none".
 */
export function UnreadNamespaces({
  unread,
  label,
  onRetry,
}: {
  unread: readonly UnreadNamespace[];
  /** The kind's plural, as the list names it. */
  label: string;
  onRetry?: () => void;
}) {
  const t = useT();
  if (unread.length === 0) return null;
  return (
    <div className="mb-2 flex flex-col gap-1.5" data-testid="unread-namespaces">
      {unread.map((missing) => (
        <Unknown
          key={missing.namespace}
          question={t("empty", "couldNotReadInNamespace", {
            label: label.toLowerCase(),
            namespace: missing.namespace,
          })}
          error={missing}
          onRetry={onRetry}
        />
      ))}
    </div>
  );
}
