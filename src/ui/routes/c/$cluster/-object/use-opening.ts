import { startTransition, useState } from "react";

/**
 * A button whose dialog takes a moment to draw. `begin` marks the button
 * pending and opens the dialog as a transition, so the mark paints before the
 * dialog's own render; the mark ends once `opened` is committed.
 */
export function useOpening(opened: boolean) {
  const [pressed, setPressed] = useState(false);
  if (opened && pressed) setPressed(false);
  return {
    opening: pressed && !opened,
    begin: (open: () => void) => {
      setPressed(true);
      startTransition(open);
    },
  };
}
