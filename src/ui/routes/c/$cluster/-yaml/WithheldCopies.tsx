import { lazy, Suspense } from "react";

import { WITHHELD_MARKER } from "@/lib/withheld";

const WithheldCopiesImpl = lazy(() => import("./WithheldCopiesImpl"));

/**
 * Says which annotations of a manifest hold a record the app blanked.
 *
 * `kubectl apply` keeps the manifest it sent in an annotation, and a private
 * key withheld under `data` is withheld in that record too. Drawn there, the
 * placeholder reads as what kubectl recorded, so every surface that draws a
 * manifest says whose it is. Nearly every manifest has none: nothing is
 * drawn, and the YAML parser is not loaded, until the placeholder is there.
 */
export function WithheldCopies({
  yaml,
  className,
}: {
  yaml: string | null | undefined;
  className?: string;
}) {
  if (!yaml?.includes(WITHHELD_MARKER)) return null;
  return (
    <Suspense fallback={null}>
      <WithheldCopiesImpl yaml={yaml} className={className} />
    </Suspense>
  );
}
