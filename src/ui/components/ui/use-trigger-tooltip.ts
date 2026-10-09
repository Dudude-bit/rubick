import { useRef, useState } from "react";

/**
 * A tooltip on the trigger of a menu or a popover. Shut while `menuOpen`,
 * and opened by neither the focus moving inside the menu, which a portal
 * still bubbles to the trigger, nor the focus the menu hands back as it
 * closes: either left it open over the page until the next click. Spread
 * `tooltip` on the `Tooltip` and pass `onCloseAutoFocus` to the content.
 */
export function useTriggerTooltip(menuOpen: boolean) {
  const [open, setOpen] = useState(false);
  const handingBack = useRef(false);
  return {
    tooltip: {
      open: open && !menuOpen,
      onOpenChange: (next: boolean) => {
        if (next && (menuOpen || handingBack.current)) return;
        setOpen(next);
      },
    },
    onCloseAutoFocus: () => {
      handingBack.current = true;
      window.setTimeout(() => {
        handingBack.current = false;
      });
    },
  };
}
