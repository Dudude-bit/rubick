import * as React from "react";
import * as ContextMenuPrimitive from "@radix-ui/react-context-menu";

import { cn } from "@/lib/utils";

/**
 * A menu opened at the pointer.
 *
 * Radix's own primitive rather than a `dropdown-menu` hand-positioned at
 * the cursor: the package was already a dependency, and the parts that are
 * fiddly to get right — anchoring to the press point, flipping near an
 * edge, roving focus, typeahead, and the platform's own keyboard opener —
 * are the parts it already does.
 *
 * Its one gap is that `Root` has no controlled `open`, so a menu that must
 * also open from a key the platform does not turn into a `contextmenu`
 * event needs `openContextMenu` below. Skin and surface are the dropdown's:
 * an overlay is the one place this canvas is allowed elevation.
 */
const ContextMenu = ContextMenuPrimitive.Root;

const ContextMenuGroup = ContextMenuPrimitive.Group;

const ContextMenuPortal = ContextMenuPrimitive.Portal;

/**
 * The trigger, plus a way in that does not need a mouse.
 *
 * Windows and most Linux desktops turn Shift+F10 and the Menu key into a
 * `contextmenu` event by themselves, but not every keyboard has that key,
 * and a right-click-only affordance is not an affordance for everyone. Down
 * is the same key that opens a `<select>`, and it goes through the same
 * event so the menu behaves identically however it was asked for.
 *
 * Synthesising the event is the only route: `ContextMenu.Root` has no
 * controlled `open`. It is dispatched at the trigger's own bottom-left,
 * because a keyboard event's zeroed coordinates would put the menu in the
 * corner of the window instead of under the control that owns it.
 */
const ContextMenuTrigger = React.forwardRef<
  React.ElementRef<typeof ContextMenuPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.Trigger>
>(({ onKeyDown, ...props }, ref) => (
  <ContextMenuPrimitive.Trigger
    ref={ref}
    onKeyDown={(event) => {
      onKeyDown?.(event);
      if (event.defaultPrevented || event.key !== "ArrowDown") return;
      event.preventDefault();
      const box = event.currentTarget.getBoundingClientRect();
      event.currentTarget.dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          clientX: box.left,
          clientY: box.bottom,
        })
      );
    }}
    {...props}
  />
));
ContextMenuTrigger.displayName = ContextMenuPrimitive.Trigger.displayName;

const ContextMenuContent = React.forwardRef<
  React.ElementRef<typeof ContextMenuPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.Content>
>(({ className, ...props }, ref) => (
  <ContextMenuPrimitive.Portal>
    <ContextMenuPrimitive.Content
      ref={ref}
      className={cn(
        "z-50 min-w-[9rem] overflow-hidden rounded-lg border border-hair bg-raise p-1 text-fg-mid shadow-pop data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95",
        className
      )}
      {...props}
    />
  </ContextMenuPrimitive.Portal>
));
ContextMenuContent.displayName = ContextMenuPrimitive.Content.displayName;

const ContextMenuItem = React.forwardRef<
  React.ElementRef<typeof ContextMenuPrimitive.Item>,
  React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.Item>
>(({ className, ...props }, ref) => (
  <ContextMenuPrimitive.Item
    ref={ref}
    className={cn(
      "relative flex cursor-default select-none items-center rounded-[5px] px-[7px] py-[5px] text-xs outline-none transition-colors focus:bg-hover focus:text-fg data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
      className
    )}
    {...props}
  />
));
ContextMenuItem.displayName = ContextMenuPrimitive.Item.displayName;

const ContextMenuLabel = React.forwardRef<
  React.ElementRef<typeof ContextMenuPrimitive.Label>,
  React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.Label>
>(({ className, ...props }, ref) => (
  <ContextMenuPrimitive.Label
    ref={ref}
    className={cn(
      "px-[7px] pb-[3px] pt-[7px] text-[10px] font-semibold uppercase tracking-[0.07em] text-fg-fnt",
      className
    )}
    {...props}
  />
));
ContextMenuLabel.displayName = ContextMenuPrimitive.Label.displayName;

const ContextMenuSeparator = React.forwardRef<
  React.ElementRef<typeof ContextMenuPrimitive.Separator>,
  React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.Separator>
>(({ className, ...props }, ref) => (
  <ContextMenuPrimitive.Separator
    ref={ref}
    className={cn("-mx-1 my-1 h-px bg-hair", className)}
    {...props}
  />
));
ContextMenuSeparator.displayName = ContextMenuPrimitive.Separator.displayName;

export {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuGroup,
  ContextMenuPortal,
};
