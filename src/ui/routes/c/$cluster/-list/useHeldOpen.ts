import { useRef } from "react";

/**
 * For a dialog that closes itself on confirm, where the write has not
 * answered: `hold` the promise and a close in the meantime is ignored, so the
 * dialog stays up with its pending mark until the write settles.
 */
export function useHeldOpen(close: () => void) {
  const held = useRef(false);
  return {
    onOpenChange: (open: boolean) => {
      if (!open && !held.current) close();
    },
    hold: <T>(work: Promise<T>) => {
      held.current = true;
      return work.finally(() => {
        held.current = false;
      });
    },
  };
}
