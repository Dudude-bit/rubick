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
import { commands } from "@/lib/commands";
import { ResourceType } from "@/lib/resource-registry";
import type { GatewayInfo } from "@/generated/types";

function programmed(gateway: GatewayInfo): {
  text: string;
  tone: "ok" | "err" | "mute";
} {
  const condition = gateway.conditions.find((c) => c.type === "Programmed");
  if (!condition) return { text: "no controller answered", tone: "mute" };
  if (condition.status === "True") return { text: "programmed", tone: "ok" };
  if (condition.status === "False") {
    return { text: condition.reason ?? "not programmed", tone: "err" };
  }
  return { text: "unknown", tone: "mute" };
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
      header: "Class",
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
      header: "Listeners",
      size: 90,
      cell: ({ row }) => {
        const total = row.original.listeners.length;
        const contributed = row.original.listeners.filter(
          (l) => l.fromListenerSet !== null
        ).length;
        return (
          <span className="text-fg-fnt">
            {total}
            {contributed > 0 && ` (+${contributed} from sets)`}
          </span>
        );
      },
    },
    {
      id: "addresses",
      header: "Addresses",
      size: 180,
      cell: ({ row }) => {
        const addresses = row.original.addresses;
        if (addresses.length === 0)
          return <span className="text-fg-fnt">—</span>;
        return (
          <span className="truncate">
            <CopyableAddress value={addresses[0]} label="Gateway address" />
            {addresses.length > 1 && (
              <span className="text-fg-fnt"> +{addresses.length - 1}</span>
            )}
          </span>
        );
      },
    },
    {
      id: "programmed",
      header: "Programmed",
      size: 170,
      cell: ({ row }) => {
        const said = programmed(row.original);
        return <span className={TONE_CLASS[said.tone]}>{said.text}</span>;
      },
    },
    createAgeColumn<GatewayInfo>(),
  ],
});
