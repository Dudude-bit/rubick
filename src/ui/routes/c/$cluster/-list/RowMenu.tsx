import { Fragment } from "react";
import { useNavigate } from "@tanstack/react-router";
import {
  ArrowUpRight,
  Copy,
  ExternalLink,
  Link2,
  PanelRight,
  SquareChevronRight,
  type LucideIcon,
} from "lucide-react";

import {
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
} from "@/components/ui/dropdown-menu";
import { PointMenu } from "@/components/ui/point-menu";
import type { QuickAction } from "@/components/ui/quick-actions";
import { useCopyToClipboard } from "@/hooks/useCopyToClipboard";
import { peekTargetOfHref, usePeek } from "@/hooks/usePeek";
import { useT } from "@/i18n/useT";
import { buildDeepLink } from "@/lib/deep-link";
import { kubectlGet } from "@/lib/kubectl";
import { clusterOf } from "@/lib/links";
import { formatShortcut } from "@/lib/platform";
import { cn } from "@/lib/utils";
import { useScopeTabStore } from "@/stores/scopeTabStore";
import type { ObjectActions } from "../-object/useObjectActions";

export type Listed = { name: string; namespace?: string | null };

interface Entry {
  key: string;
  label: string;
  icon: LucideIcon;
  run: () => void;
  /** Why it cannot run; the item stays, greyed, and says so. */
  reason?: string;
  disabled?: boolean;
  danger?: boolean;
  shortcut?: string;
}

/** One row's menu: how to open it, what to copy, and what it can do. */
export function RowMenu<Row extends Listed>({
  row,
  kind,
  href,
  actions,
  quickActions,
  at,
  onClose,
}: {
  row: Row;
  kind: string | null;
  href: string | undefined;
  actions: ObjectActions;
  quickActions: QuickAction<Row>[];
  at: { x: number; y: number };
  onClose: () => void;
}) {
  const t = useT();
  const copy = useCopyToClipboard();
  const navigate = useNavigate();
  const { open: openPeek } = usePeek();
  const openTab = useScopeTabStore((state) => state.openTab);

  const peek = href ? peekTargetOfHref(href) : null;
  const qualified = row.namespace ? `${row.namespace}/${row.name}` : null;
  const command = kind ? kubectlGet({ kind, ...row }) : null;
  const link = href && clusterOf(href) ? buildDeepLink(href) : null;
  const copyText = (text: string) =>
    void copy(text, t("action", "nameCopied", { name: text }));

  const opens: Entry[] = href
    ? [
        {
          key: "open",
          label: t("action", "openRow"),
          icon: ArrowUpRight,
          run: () => void navigate({ href }),
          shortcut: peek ? undefined : "enter",
        },
        ...(peek
          ? [
              {
                key: "peek",
                label: t("action", "openInPanel"),
                icon: PanelRight,
                run: () => openPeek(peek),
                shortcut: "enter",
              },
            ]
          : []),
        {
          key: "tab",
          label: t("action", "openInNewTab"),
          icon: ExternalLink,
          run: () => void openTab({ href, background: true }),
        },
      ]
    : [];

  const copies: Entry[] = [
    {
      key: "name",
      label: t("action", "copyName"),
      icon: Copy,
      run: () => copyText(row.name),
    },
    ...(qualified
      ? [
          {
            key: "qualified",
            label: t("action", "copyQualifiedName"),
            icon: Copy,
            run: () => copyText(qualified),
          },
        ]
      : []),
    ...(command
      ? [
          {
            key: "kubectl",
            label: t("action", "copyKubectlGet"),
            icon: SquareChevronRight,
            run: () => copyText(command),
          },
        ]
      : []),
    ...(link
      ? [
          {
            key: "link",
            label: t("action", "copyLink"),
            icon: Link2,
            run: () =>
              void copy(
                link,
                t("cluster", "objectLinkCopied", { name: row.name })
              ),
          },
        ]
      : []),
  ];

  const planned: Entry[] = [...actions.plan.inline, ...actions.plan.menu].map(
    (action) => ({
      key: action.id,
      label: action.label,
      icon: action.icon,
      reason: action.reason,
      disabled: actions.busy[action.id],
      danger: action.danger,
      run: () => actions.run(action.id),
    })
  );
  // The row's own buttons, less the ones the peek's set already holds under
  // the same name: the peek's Delete asks with what goes with it.
  const said = new Set([
    t("action", "viewDetails"),
    ...planned.map((entry) => entry.label),
  ]);
  const own: Entry[] = quickActions
    .filter((action) => !action.hidden?.(row) && !said.has(action.label))
    .map((action) => ({
      key: `own-${action.label}`,
      label: action.label,
      icon: action.icon,
      reason: action.reason?.(row),
      disabled: action.disabled?.(row),
      danger: action.variant === "destructive",
      run: () => action.onClick(row),
    }));
  const acts = [...planned, ...own];

  const groups = [
    opens,
    copies,
    acts.filter((entry) => !entry.danger),
    acts.filter((entry) => entry.danger),
  ].filter((group) => group.length > 0);

  return (
    <PointMenu
      x={at.x}
      y={at.y}
      onClose={onClose}
      className="min-w-[220px] max-w-[320px]"
    >
      <DropdownMenuLabel className="truncate font-mono normal-case tracking-normal">
        {qualified ?? row.name}
      </DropdownMenuLabel>
      {groups.map((group, index) => (
        <Fragment key={group[0].key}>
          {index > 0 && <DropdownMenuSeparator />}
          <DropdownMenuGroup>
            {group.map((entry) => (
              <DropdownMenuItem
                key={entry.key}
                disabled={!!entry.reason || entry.disabled}
                onSelect={entry.run}
                className={cn(
                  "gap-2",
                  entry.danger && "text-err focus:bg-err/16 focus:text-err"
                )}
              >
                <entry.icon className="size-3.5 flex-none" aria-hidden />
                <span className="flex min-w-0 flex-col">
                  {entry.label}
                  {entry.reason && (
                    <span className="text-[11px] text-fg-fnt">
                      {entry.reason}
                    </span>
                  )}
                </span>
                {entry.shortcut && (
                  <DropdownMenuShortcut>
                    {formatShortcut(entry.shortcut)}
                  </DropdownMenuShortcut>
                )}
              </DropdownMenuItem>
            ))}
          </DropdownMenuGroup>
        </Fragment>
      ))}
    </PointMenu>
  );
}
