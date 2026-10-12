import type { ReactNode } from "react";
import { createPortal } from "react-dom";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

/**
 * A menu opened at a point rather than under a control: where the pointer
 * right-clicked, or under the row the Menu key was pressed on.
 *
 * Into the body, because `position: fixed` is measured from the nearest
 * ancestor with a transform, and the page container carries one: the menu
 * opened a sidebar's width away from the pointer.
 */
export function PointMenu({
  x,
  y,
  onClose,
  className,
  children,
}: {
  x: number;
  y: number;
  onClose: () => void;
  className?: string;
  children: ReactNode;
}) {
  return createPortal(
    <DropdownMenu open onOpenChange={(open) => !open && onClose()}>
      <DropdownMenuTrigger asChild>
        <span
          aria-hidden
          style={{ position: "fixed", left: x, top: y }}
          className="size-0"
        />
      </DropdownMenuTrigger>
      {/* As tall as its items where the window has the room: a row's menu
          capped at 24rem hid Delete under a scroll with 90 px free below. */}
      <DropdownMenuContent
        align="start"
        collisionPadding={8}
        className={cn(
          "max-h-(--radix-dropdown-menu-content-available-height)",
          className
        )}
      >
        {children}
      </DropdownMenuContent>
    </DropdownMenu>,
    document.body
  );
}
