import * as React from "react";

import { Input, type InputProps } from "@/components/ui/input";
import { useShownPath } from "@/lib/hide-paths";

type PathInputProps = Omit<InputProps, "value"> & { value: string };

/**
 * A field for a path on this computer. While nobody is typing in it, it
 * draws the path the way "hide names and paths" draws every other one; the
 * real path is under the cursor and in `value`, which is never changed.
 */
export const PathInput = React.forwardRef<HTMLInputElement, PathInputProps>(
  ({ value, onFocus, onBlur, ...props }, ref) => {
    const show = useShownPath();
    const [focused, setFocused] = React.useState(false);
    return (
      <Input
        {...props}
        ref={ref}
        value={focused ? value : show(value)}
        onFocus={(event) => {
          setFocused(true);
          onFocus?.(event);
        }}
        onBlur={(event) => {
          onBlur?.(event);
          setFocused(false);
        }}
      />
    );
  }
);
PathInput.displayName = "PathInput";
