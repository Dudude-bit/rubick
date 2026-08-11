import * as React from "react";
import * as SwitchPrimitives from "@radix-ui/react-switch";
import { cn } from "@/lib/utils";

/**
 * On means "the foreground colour", not "the brand colour" — the design has
 * no brand fill left to spend, and a saturated pill was the loudest object
 * on the Settings screen. The track is also row-height (16px) rather than
 * the shadcn default 24px, so a settings row sits on the same rhythm as a
 * table row.
 */
const Switch = React.forwardRef<
  React.ElementRef<typeof SwitchPrimitives.Root>,
  React.ComponentPropsWithoutRef<typeof SwitchPrimitives.Root>
>(({ className, ...props }, ref) => (
  <SwitchPrimitives.Root
    className={cn(
      "peer inline-flex h-4 w-7 shrink-0 cursor-pointer items-center rounded-full px-[2px] transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-info disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:bg-fg data-[state=unchecked]:bg-sel",
      className
    )}
    {...props}
    ref={ref}
  >
    <SwitchPrimitives.Thumb
      className={cn(
        "pointer-events-none block h-3 w-3 rounded-full transition-transform data-[state=checked]:translate-x-3 data-[state=checked]:bg-canvas data-[state=unchecked]:translate-x-0 data-[state=unchecked]:bg-fg-mut"
      )}
    />
  </SwitchPrimitives.Root>
));
Switch.displayName = SwitchPrimitives.Root.displayName;

export { Switch };
