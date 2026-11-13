import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

/**
 * A notice, drawn in the frame `Unknown` draws: a could-not-look notice and a
 * warning read as one thing, dashed; information is the same frame, solid,
 * with its glyph in the info hue. The glyph and the text sit where
 * `Unknown`'s do, so two notices stacked line up.
 */
const alertVariants = cva(
  "relative w-full rounded-md border px-3 py-2 text-xs [&>svg~*]:pl-[22px] [&>svg]:absolute [&>svg]:left-3 [&>svg]:top-2.5 [&>svg]:h-3.5 [&>svg]:w-3.5",
  {
    variants: {
      variant: {
        default: "border-hair text-fg-mid [&>svg]:text-fg-mut",
        destructive: "border-err text-err [&>svg]:text-err",
        warn: "border-dashed border-hair text-fg-mid [&>svg]:text-warn",
        info: "border-hair text-fg-mid [&>svg]:text-info",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
);

const Alert = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement> & VariantProps<typeof alertVariants>
>(({ className, variant, ...props }, ref) => (
  <div
    ref={ref}
    role="alert"
    className={cn(alertVariants({ variant }), className)}
    {...props}
  />
));
Alert.displayName = "Alert";

const AlertTitle = React.forwardRef<
  HTMLParagraphElement,
  React.HTMLAttributes<HTMLHeadingElement>
>(({ className, ...props }, ref) => (
  <h5
    ref={ref}
    className={cn("mb-0.5 font-medium leading-none tracking-tight", className)}
    {...props}
  />
));
AlertTitle.displayName = "AlertTitle";

const AlertDescription = React.forwardRef<
  HTMLParagraphElement,
  React.HTMLAttributes<HTMLParagraphElement>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    className={cn("text-xs [&_p]:leading-relaxed", className)}
    {...props}
  />
));
AlertDescription.displayName = "AlertDescription";

export { Alert, AlertTitle, AlertDescription };
