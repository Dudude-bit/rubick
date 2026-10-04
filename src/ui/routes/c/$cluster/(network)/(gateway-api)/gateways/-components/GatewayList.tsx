/**
 * Gateways, listed by what decides their fate: the class that claims them,
 * the addresses a controller gave them, and whether it called them
 * Programmed — with "nothing answered" kept apart from "broken".
 */

import { createResourceListPage } from "../../../../-list/createResourceListPage";
import {
  createAgeColumn,
  createNameColumn,
  createNamespaceColumn,
} from "../../../../-list/columns";
import { CopyableAddress } from "@/components/ui/copyable-value";
import { ResourceRef } from "@/components/resources/ResourceRef";
import { columnHeader } from "@/i18n/column-header";
import { useT, type T } from "@/i18n/useT";
import { commands } from "@/lib/commands";
import { ResourceType } from "@/lib/resource-registry";
import type { GatewayInfo } from "@/generated/types";
import { gatewayProgrammed } from "@/lib/route-trace";

/** The controller's reason is quoted raw; only this app's own words are
 *  spoken through the catalogue. */
function programmedOf(
  gateway: GatewayInfo,
  t: T
): { text: string; tone: "ok" | "err" | "mute" } {
  const condition = gatewayProgrammed(gateway);
  return !condition
    ? { text: t("empty", "gwNoControllerShort"), tone: "mute" }
    : condition.status === "True"
      ? { text: t("empty", "gwProgrammedWord"), tone: "ok" }
      : condition.status === "False"
        ? {
            text: condition.reason ?? t("empty", "gwNotProgrammedWord"),
            tone: "err",
          }
        : { text: t("empty", "gwPolicyUnknown"), tone: "mute" };
}

// oxlint-disable-next-line react-refresh/only-export-components
function ProgrammedCell({ gateway }: { gateway: GatewayInfo }) {
  const t = useT();
  const said = programmedOf(gateway, t);
  return <span className={TONE_CLASS[said.tone]}>{said.text}</span>;
}

function listenersOf(gateway: GatewayInfo, t: T): string {
  const contributed = gateway.listeners.filter(
    (l) => l.fromListenerSet !== null
  ).length;
  return `${gateway.listeners.length}${
    contributed > 0 ? ` ${t("count", "fromSets", { n: contributed })}` : ""
  }`;
}

// oxlint-disable-next-line react-refresh/only-export-components
function ListenersCell({ gateway }: { gateway: GatewayInfo }) {
  const t = useT();
  return <span className="text-fg-fnt">{listenersOf(gateway, t)}</span>;
}

// oxlint-disable-next-line react-refresh/only-export-components
function AddressesCell({ gateway }: { gateway: GatewayInfo }) {
  const t = useT();
  const addresses = gateway.addresses;
  if (addresses.length === 0) return <span className="text-fg-fnt">—</span>;
  return (
    <span className="truncate">
      <CopyableAddress
        value={addresses[0]}
        label={t("columns", "gatewayAddress")}
      />
      {addresses.length > 1 && (
        <span className="text-fg-fnt"> +{addresses.length - 1}</span>
      )}
    </span>
  );
}

const TONE_CLASS = {
  ok: "text-ok",
  err: "text-err",
  mute: "text-fg-fnt",
} as const;

export const GatewayList = createResourceListPage<GatewayInfo>({
  resourceType: ResourceType.Gateway,
  title: "Gateways",
  fetcher: ({ scope }) => commands.listGatewaysIn(scope),
  deleter: (item) => commands.deleteGateway(item.name, item.namespace),
  // Polled, not watched: the listener count folds in the ListenerSets that
  // attach to each Gateway, which a watch event cannot see from the object
  // alone, and every status update replaced the merged row with a bare one.
  columns: () => [
    createNameColumn<GatewayInfo>(ResourceType.Gateway),
    createNamespaceColumn<GatewayInfo>(),
    {
      accessorKey: "className",
      header: columnHeader("columns", "class"),
      size: 140,
      cell: ({ row }) =>
        row.original.className ? (
          <ResourceRef
            kind={ResourceType.GatewayClass}
            name={row.original.className}
            showKind={false}
          />
        ) : (
          <span className="text-fg-fnt">—</span>
        ),
    },
    {
      id: "listeners",
      header: columnHeader("columns", "listeners"),
      meta: { share: (row: GatewayInfo, t) => listenersOf(row, t) },
      size: 90,
      cell: ({ row }) => <ListenersCell gateway={row.original} />,
    },
    {
      id: "addresses",
      header: columnHeader("columns", "addresses"),
      meta: {
        share: (row: GatewayInfo) => ({
          text: row.addresses.join(", ") || "—",
          mono: true,
        }),
      },
      size: 180,
      cell: ({ row }) => <AddressesCell gateway={row.original} />,
    },
    {
      id: "programmed",
      header: columnHeader("columns", "programmed"),
      meta: {
        share: (row: GatewayInfo, t) => {
          const said = programmedOf(row, t);
          return {
            text: said.text,
            role: said.tone === "mute" ? "neutral" : said.tone,
          };
        },
      },
      size: 170,
      cell: ({ row }) => <ProgrammedCell gateway={row.original} />,
    },
    createAgeColumn<GatewayInfo>(),
  ],
});
