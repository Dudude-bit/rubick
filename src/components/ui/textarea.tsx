import * as React from "react";
import { cn } from "@/lib/utils";

export type TextareaProps = React.TextareaHTMLAttributes<HTMLTextAreaElement>;

const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ className, ...props }, ref) => {
    return (
      <textarea
        className={cn(
          // Same shell as Input, only taller: hairline border, no fill.
          "flex min-h-[80px] w-full rounded-md border border-hair bg-transparent px-2 py-1.5 text-xs text-fg transition-colors placeholder:text-fg-fnt hover:bg-hover focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-info disabled:cursor-not-allowed disabled:opacity-50",
          className
        )}
        ref={ref}
        {...props}
      />
    );
  }
);
Textarea.displayName = "Textarea";

export { Textarea };
