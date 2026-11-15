import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";

/**
 * On the flat canvas a button is a label with a hit area, not a raised
 * block. The affirmative action separates itself by contrast (canvas text
 * inverted) rather than by a brand fill, so no hue is spent on "this is
 * the button" — hue stays reserved for state.
 */
const buttonVariants = cva(
  // A dialog that hands its Cancel focus as it opens rings it however it was
  // opened: after a click, focus moved from code is not `:focus-visible`.
  "inline-flex items-center justify-center whitespace-nowrap rounded-md text-xs font-medium transition-colors focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-info data-autofocus:focus:outline-hidden data-autofocus:focus:ring-1 data-autofocus:focus:ring-info disabled:pointer-events-none disabled:opacity-50 aria-disabled:pointer-events-none aria-disabled:opacity-50",
  {
    variants: {
      variant: {
        default: "bg-fg text-canvas hover:bg-fg-mid",
        destructive:
          "bg-err/16 text-err hover:bg-err/24 disabled:bg-sel disabled:text-fg-fnt",
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
  /** The action is running: a spinner takes the icon's place and the button holds still. */
  pending?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  (
    {
      className,
      variant,
      size,
      asChild = false,
      pending = false,
      children,
      ...props
    },
    ref
  ) => {
    if (asChild)
      return (
        <Slot
          className={cn(buttonVariants({ variant, size, className }))}
          ref={ref}
          {...props}
        >
          {children}
        </Slot>
      );
    return (
      <button
        className={cn(
          buttonVariants({ variant, size, className }),
          pending && "[&>svg:not([data-spinner])]:hidden"
        )}
        ref={ref}
        {...props}
        disabled={props.disabled || pending}
        aria-busy={pending || props["aria-busy"] || undefined}
      >
        {pending && (
          <Spinner
            data-spinner
            size="xs"
            aria-hidden="true"
            className={cn("flex-none", size !== "icon" && "mr-1.5")}
          />
        )}
        {children}
      </button>
    );
  }
);
Button.displayName = "Button";

// `buttonVariants` co-located with the Button component — same
// HMR / consumer-ergonomics trade-off as Badge / quick-actions.
// oxlint-disable-next-line react-refresh/only-export-components
export { Button, buttonVariants };
