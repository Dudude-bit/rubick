import * as React from "react";
import { cn } from "@/lib/utils";

export type InputProps = React.InputHTMLAttributes<HTMLInputElement>;

const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, type, ...props }, ref) => {
    return (
      <input
        type={type}
        className={cn(
          // Same shell as the Select trigger: 24px tall, hairline border,
          // no fill of its own. A filled input box is the card pattern at
          // control scale.
          "flex h-7 w-full rounded-md border border-hair bg-transparent px-2 text-xs text-fg transition-colors file:border-0 file:bg-transparent file:text-xs file:font-medium placeholder:text-fg-fnt hover:bg-hover focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-info disabled:cursor-not-allowed disabled:opacity-50",
          className
        )}
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck={false}
        ref={ref}
        {...props}
      />
    );
  }
);
Input.displayName = "Input";

export { Input };
