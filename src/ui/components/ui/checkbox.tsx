import * as React from "react";
import * as CheckboxPrimitive from "@radix-ui/react-checkbox";
import { Check } from "lucide-react";
import { cn } from "@/lib/utils";

const Checkbox = React.forwardRef<
  React.ElementRef<typeof CheckboxPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof CheckboxPrimitive.Root>
>(({ className, ...props }, ref) => (
  <CheckboxPrimitive.Root
    ref={ref}
    className={cn(
      // Unchecked is a hairline box like every other input; checked inverts
      // to the foreground — the same "affirmative by contrast, not by hue"
      // move the default Button makes.
      "peer h-3.5 w-3.5 shrink-0 rounded-[3px] border border-hair transition-colors focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-info disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:border-fg data-[state=checked]:bg-fg data-[state=checked]:text-canvas",
      className
    )}
    {...props}
  >
    <CheckboxPrimitive.Indicator
      className={cn("flex items-center justify-center text-current")}
    >
      <Check className="h-3 w-3" strokeWidth={3} />
    </CheckboxPrimitive.Indicator>
  </CheckboxPrimitive.Root>
));
Checkbox.displayName = CheckboxPrimitive.Root.displayName;

export { Checkbox };
