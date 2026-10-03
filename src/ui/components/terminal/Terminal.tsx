import { lazy, Suspense } from "react";

import type { TerminalProps } from "./TerminalImpl";
import { useT } from "@/i18n/useT";

export type { TerminalProps, TerminalMetadata } from "./TerminalImpl";

/**
 * Lazy wrapper around the heavy xterm-backed terminal.
 *
 * `@xterm/xterm` + addons + the xterm CSS add ~60 KB gzipped to the
 * initial bundle and only users who open a pod shell or auth modal
 * ever need it. Splitting behind React.lazy means the chunk is only
 * fetched when a Terminal first mounts.
 */
const TerminalImpl = lazy(() =>
  import("./TerminalImpl").then((mod) => ({ default: mod.Terminal }))
);

export function Terminal(props: TerminalProps) {
  const t = useT();
  return (
    <Suspense
      fallback={
        <div
          className="flex h-full w-full items-center justify-center text-xs text-fg-mut"
          aria-busy="true"
        >
          {t("empty", "loadingTerminal")}
        </div>
      }
    >
      <TerminalImpl {...props} />
    </Suspense>
  );
}
