import * as React from "react";
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

type SpinnerSize = "xs" | "sm" | "md" | "lg";

const sizeClasses: Record<SpinnerSize, string> = {
  xs: "h-3 w-3",
  sm: "h-4 w-4",
  md: "h-5 w-5",
  lg: "h-8 w-8",
};

type SpinnerProps = React.ComponentPropsWithoutRef<typeof Loader2> & {
  size?: SpinnerSize;
};

export function Spinner({ size = "sm", className, ...props }: SpinnerProps) {
  return (
    <Loader2
      className={cn("animate-spin", sizeClasses[size], className)}
      {...props}
    />
  );
}
