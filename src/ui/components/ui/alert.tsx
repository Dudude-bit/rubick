import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

/**
 * A notice, not a panel. The old boxed alert was a card with a coloured
 * fill; here the message is carried by a 2px rule down its left edge and
 * by the colour of the text itself, so it sits on the canvas like any
 * other paragraph.
 */
const alertVariants = cva(
  "relative w-full border-l-2 py-1.5 pl-2.5 text-xs [&>svg~*]:pl-6 [&>svg]:absolute [&>svg]:left-2.5 [&>svg]:top-2 [&>svg]:h-3.5 [&>svg]:w-3.5",
  {
    variants: {
      variant: {
        default: "border-hair text-fg-mid [&>svg]:text-fg-mut",
        destructive: "border-err text-err [&>svg]:text-err",
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
