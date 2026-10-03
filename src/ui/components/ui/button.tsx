import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

/**
 * On the flat canvas a button is a label with a hit area, not a raised
 * block. The affirmative action separates itself by contrast (canvas text
 * inverted) rather than by a brand fill, so no hue is spent on "this is
 * the button" — hue stays reserved for state.
 */
const buttonVariants = cva(
  "inline-flex items-center justify-center whitespace-nowrap rounded-md text-xs font-medium transition-colors focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-info disabled:pointer-events-none disabled:opacity-50",
  {
    variants: {
      variant: {
        default: "bg-fg text-canvas hover:bg-fg-mid",
        destructive: "bg-err/16 text-err hover:bg-err/24",
        outline: "border border-hair text-fg-mid hover:bg-hover hover:text-fg",
        secondary: "bg-sel text-fg-mid hover:bg-hover hover:text-fg",
        ghost: "text-fg-mut hover:bg-hover hover:text-fg",
        link: "text-info underline-offset-4 hover:underline",
      },
      // Row-height sizes: the app is a dense table client, so the default
      // button has to fit the same 24px rhythm as a compact table row.
      size: {
        default: "h-7 px-2.5",
        sm: "h-6 px-2",
        lg: "h-8 px-4",
        icon: "h-7 w-7",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
);

export interface ButtonProps
  extends
    React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return (
      <Comp
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        {...props}
      />
    );
  }
);
Button.displayName = "Button";

// `buttonVariants` co-located with the Button component — same
// HMR / consumer-ergonomics trade-off as Badge / quick-actions.
// eslint-disable-next-line react-refresh/only-export-components
export { Button, buttonVariants };
