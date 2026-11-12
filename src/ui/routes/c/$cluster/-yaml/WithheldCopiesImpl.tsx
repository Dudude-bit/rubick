import { useMemo } from "react";

import { useT } from "@/i18n/useT";
import { cn } from "@/lib/utils";

import { withheldCopiesIn } from "./manifest-reads";

/** One line for each annotation of `yaml` that holds a blanked record. */
export default function WithheldCopiesImpl({
  yaml,
  className,
}: {
  yaml: string;
  className?: string;
}) {
  const t = useT();
  const copies = useMemo(() => withheldCopiesIn(yaml), [yaml]);
  return copies.map(({ annotation, keys }) => (
    <p
      key={annotation}
      role="note"
      className={cn("flex-none pb-2 text-[11px] text-fg-mut", className)}
    >
      {t("action", "yamlCopyWithheld", { annotation, keys: keys.join(", ") })}
    </p>
  ));
}
