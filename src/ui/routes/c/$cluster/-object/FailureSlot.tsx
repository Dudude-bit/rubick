import { useEffect, useState } from "react";

import { WriteFailure } from "@/components/ui/write-failure";
import { cn } from "@/lib/utils";

/**
 * A write's failure inside its dialog. It opens by height instead of
 * appearing, and the last failure stays through a retry, so the buttons
 * under it do not jump when the answer arrives or the retry starts.
 */
export function FailureSlot({
  error,
  busy,
}: {
  error: unknown;
  busy: boolean;
}) {
  const failed = error != null;
  const [last, setLast] = useState(error);
  const [open, setOpen] = useState(false);
  if (failed && last !== error) setLast(error);
  const kept = failed || (busy && last != null);
  useEffect(() => {
    const frame = requestAnimationFrame(() => setOpen(kept));
    return () => cancelAnimationFrame(frame);
  }, [kept]);
  if (last == null) return null;
  return (
    <div
      className={cn(
        "grid transition-[grid-template-rows] duration-150 motion-reduce:transition-none",
        open ? "grid-rows-[1fr]" : "grid-rows-[0fr]"
      )}
    >
      <div className="min-h-0 overflow-hidden">
        <WriteFailure error={last} className={cn(busy && "opacity-60")} />
      </div>
    </div>
  );
}
