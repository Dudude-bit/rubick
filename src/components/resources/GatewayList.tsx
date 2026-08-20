/**
 * Gateways, listed by what decides their fate: the class that claims them,
 * the addresses a controller gave them, and whether it called them
 * Programmed — with "nothing answered" kept apart from "broken".
 */

import { createResourceListPage } from "./createResourceListPage";
import {
  createAgeColumn,
  createNameColumn,
  createNamespaceColumn,
} from "./columns";
import { CopyableAddress } from "@/components/ui/copyable-value";
import { ResourceRef } from "./ResourceRef";
import { T } from "@/i18n/T";
import { useT } from "@/i18n/useT";
import { commands } from "@/lib/commands";
import { ResourceType } from "@/lib/resource-registry";
import type { GatewayInfo } from "@/generated/types";

/** The controller's reason is quoted raw; only this app's own words are
 *  spoken through the catalogue. */
// eslint-disable-next-line react-refresh/only-export-components
function ProgrammedCell({ gateway }: { gateway: GatewayInfo }) {
  const t = useT();
  const condition = gateway.conditions.find((c) => c.type === "Programmed");
  const said = !condition
    ? { text: t("empty", "gwNoControllerShort"), tone: "mute" as const }
    : condition.status === "True"
      ? { text: t("empty", "gwProgrammedWord"), tone: "ok" as const }
      : condition.status === "False"
        ? {
            text: condition.reason ?? t("empty", "gwNotProgrammedWord"),
            tone: "err" as const,
          }
        : { text: t("empty", "gwPolicyUnknown"), tone: "mute" as const };
  return <span className={TONE_CLASS[said.tone]}>{said.text}</span>;
}

// eslint-disable-next-line react-refresh/only-export-components
function ListenersCell({ gateway }: { gateway: GatewayInfo }) {
  const t = useT();
  const total = gateway.listeners.length;
  const contributed = gateway.listeners.filter(
    (l) => l.fromListenerSet !== null
  ).length;
  return (
    <span className="text-fg-fnt">
      {total}
      {contributed > 0 && ` ${t("count", "fromSets", { n: contributed })}`}
    </span>
  );
}

// eslint-disable-next-line react-refresh/only-export-components
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
  fetcher: ({ namespace }) => commands.listGateways(namespace),
  deleter: (item) => commands.deleteGateway(item.name, item.namespace),
  watch: ({ namespace }) => commands.subscribeGatewayWatch(namespace),
  searchKey: "name",
  columns: () => [
    createNameColumn<GatewayInfo>(ResourceType.Gateway),
    createNamespaceColumn<GatewayInfo>(),
    {
      accessorKey: "className",
      header: () => <T section="columns" k="class" />,
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
      header: () => <T section="columns" k="listeners" />,
      size: 90,
      cell: ({ row }) => <ListenersCell gateway={row.original} />,
    },
    {
      id: "addresses",
      header: () => <T section="columns" k="addresses" />,
      size: 180,
      cell: ({ row }) => <AddressesCell gateway={row.original} />,
    },
    {
      id: "programmed",
      header: "Programmed",
      size: 170,
      cell: ({ row }) => <ProgrammedCell gateway={row.original} />,
    },
    createAgeColumn<GatewayInfo>(),
  ],
});
