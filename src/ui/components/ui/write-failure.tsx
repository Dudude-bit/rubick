import { CircleX, Hourglass } from "lucide-react";

import { Alert } from "@/components/ui/alert";
import { useT } from "@/i18n/useT";
import { errorToShow, isUnanswered } from "@/lib/error-utils";
import { shownPath } from "@/lib/hide-paths";

/**
 * A write's answer inside the dialog that asked for it: refused or failed in
 * red, or unanswered in amber, since the cluster may have done it anyway.
 */
export function WriteFailure({
  error,
  className,
}: {
  error: unknown;
  className?: string;
}) {
  const t = useT();
  const said = shownPath(errorToShow(error));
  if (isUnanswered(error))
    return (
      <Alert variant="warn" className={className}>
        <Hourglass aria-hidden="true" />
        <p>{t("action", "writeUnansweredDetail", { said })}</p>
      </Alert>
    );
  return (
    <Alert variant="destructive" className={className}>
      <CircleX aria-hidden="true" />
      <p className="select-text wrap-break-word">{said}</p>
    </Alert>
  );
}
