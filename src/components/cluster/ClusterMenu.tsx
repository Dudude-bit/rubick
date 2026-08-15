import { forwardRef, useEffect, useRef } from "react";

import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  CLUSTER_HUES,
  clusterColor,
  clusterHueColor,
} from "@/lib/cluster-identity";
import { cn } from "@/lib/utils";
import {
  useClusterIdentityStore,
  useClusterMark,
} from "@/stores/clusterIdentityStore";
import { useScopeTabStore } from "@/stores/scopeTabStore";

/** What a hue is called, for the reader who is not looking at it. */
const HUE_NAMES: Record<number, string> = {
  132: "Green",
  184: "Cyan",
  224: "Blue",
  274: "Violet",
  318: "Pink",
};

/**
 * The menu a cluster carries wherever a cluster is offered.
 *
 * It holds what the click does not. Clicking a cluster row connects to it or
 * switches to it — so "connect" is not in here — and everything that is, is
 * something the row has no other way to do: what to call it, what colour it
 * wears, the real name on the clipboard, and a second tab on it.
 *
 * The field is the menu rather than an item that opens one: renaming is the
 * reason anybody comes here, and a two-step for the common case is a step
 * too many. It writes on every keystroke, so there is no uncommitted state
 * to lose when the menu closes, and no Save to look for.
 *
 * The context name is printed under the field at the faintest contrast the
 * theme has. This is the one moment a person is deliberately hiding it, and
 * it is the moment they most need to see which cluster they are hiding.
 */
export const ClusterMenu = forwardRef<
  HTMLElement,
  {
    context: string;
    /** The trigger. Right-click, and `openKeys`, open the menu on it. */
    children: React.ReactNode;
    openKeys?: readonly string[];
    /** Whether a plain left click opens it too, for a trigger that is only this. */
    openOnClick?: boolean;
  }
  // Whatever wraps this — the tab's cluster segment is also a popover
  // trigger — clones it with a ref and its own handlers, and both have to
  // reach the same button underneath.
>(function ClusterMenu({ context, children, openKeys, ...rest }, ref) {
  const mark = useClusterMark(context);
  const setAlias = useClusterIdentityStore((s) => s.setAlias);
  const setHue = useClusterIdentityStore((s) => s.setHue);
  const openTab = useScopeTabStore((s) => s.openTab);

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild openKeys={openKeys} ref={ref} {...rest}>
        {children}
      </ContextMenuTrigger>

      <ContextMenuContent className="w-[268px]">
        <ContextMenuLabel>Called</ContextMenuLabel>
        <AliasField
          context={context}
          alias={mark.alias ?? ""}
          onChange={(value) => setAlias(context, value)}
        />

        <ContextMenuLabel>Colour</ContextMenuLabel>
        <div className="flex items-center gap-1 px-[7px] pb-2 pt-0.5">
          <Swatch
            color={clusterColor(context)}
            name="Default"
            derived
            checked={mark.hue === undefined}
            onPick={() => setHue(context, null)}
          />
          {CLUSTER_HUES.map((hue) => (
            <Swatch
              key={hue}
              color={clusterHueColor(hue)}
              name={HUE_NAMES[hue]}
              checked={mark.hue === hue}
              onPick={() => setHue(context, hue)}
            />
          ))}
        </div>

        <ContextMenuSeparator />
        <ContextMenuItem
          onSelect={() => void navigator.clipboard.writeText(context)}
        >
          Copy context name
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => openTab({ context })}>
          Open in a new tab
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
});

/**
 * The field, and the truth under it.
 *
 * Its own component because it has to take the focus the menu just gave
 * itself, and the content only exists while the menu is open — mounting is
 * the event. `ContextMenu.Content` has no `onOpenAutoFocus` to hook (the
 * dropdown does, this one does not), so the frame after mount is the seam.
 */
function AliasField({
  context,
  alias,
  onChange,
}: {
  context: string;
  alias: string;
  onChange: (value: string) => void;
}) {
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      ref.current?.focus();
      ref.current?.select();
    });
    return () => cancelAnimationFrame(frame);
  }, []);

  return (
    <div className="px-[7px] pb-1.5">
      <input
        ref={ref}
        value={alias}
        onChange={(event) => onChange(event.target.value)}
        placeholder={context}
        aria-label={`What to call ${context}`}
        // The menu's own typeahead reads single characters, so every key
        // that is text has to stop here. Down is let through on purpose: it
        // is the way out of the field and into the items.
        onKeyDown={(event) => {
          if (event.key === "ArrowDown") return;
          event.stopPropagation();
          if (event.key !== "Enter") return;
          // `ContextMenu.Root` has no controlled `open`, so the only way to
          // shut it is the key that already shuts it. Nothing is committed
          // by this — the field writes as it is typed — it just gets the
          // menu out of the way of what was renamed.
          event.currentTarget.dispatchEvent(
            new KeyboardEvent("keydown", { key: "Escape", bubbles: true })
          );
        }}
        className="w-full rounded-[5px] border border-hair bg-canvas px-1.5 py-1 text-xs text-fg outline-hidden placeholder:text-fg-fnt focus:border-info"
      />
      <p className="mt-1 break-all font-mono text-[10px] leading-[13px] text-fg-fnt">
        {context}
      </p>
    </div>
  );
}

function Swatch({
  color,
  name,
  derived,
  checked,
  onPick,
}: {
  color: string;
  name: string;
  /** The colour the name would have picked on its own. */
  derived?: boolean;
  checked: boolean;
  onPick: () => void;
}) {
  return (
    <ContextMenuItem
      role="menuitemradio"
      aria-checked={checked}
      // Named for the reader who cannot see it, and no `title`: a native
      // tooltip here lands on top of the two items below, which is the
      // reason this app took them off the tab strip as well.
      aria-label={name}
      // Kept open: picking a colour is a thing you compare, and the strip
      // along the window edge is repainted behind the menu while you do.
      onSelect={(event) => {
        event.preventDefault();
        onPick();
      }}
      className={cn(
        "h-[22px] w-[22px] justify-center rounded-full p-0 ring-1 ring-inset ring-hair focus:bg-transparent",
        checked && "ring-2 ring-fg"
      )}
      style={{ background: color }}
    >
      {/* The derived swatch has to say that it is a default rather than a
          seventh colour to choose from, and a name it borrows from whichever
          cluster it sits on cannot say that. The notch can. */}
      {derived && (
        <span className="h-[9px] w-[2px] rotate-45 rounded-full bg-canvas" />
      )}
    </ContextMenuItem>
  );
}
