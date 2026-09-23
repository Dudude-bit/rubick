import { nodeReadyWord } from "@/lib/node-reporting";

import { CopyableAddress } from "@/components/ui/copyable-value";
import { commands } from "@/lib/commands";
import { nodePlacement, statesPlacement } from "@/lib/node-pool";
import type { T as Translate } from "@/i18n/useT";
import type { NodeInfo } from "@/generated/types";
import {
  list,
  source,
  type PeekGroup,
  type PeekSources,
} from "./peek-sources-kit";

/**
 * What a managed cluster already says about the machine under a node: which
 * pool made it, what it is, where it sits, and whether it can be taken back.
 *
 * The Nodes list groups by these and the Node page states them; a peek is
 * where most readers meet a node first, so it says them too — through
 * `node-pool`, which is where the vendors' spellings are reached from, rather
 * than by reading a label key here.
 *
 * Absent when nothing states any of it. A k3d or bare-metal node is not "not
 * spot" and has no pool of "none"; it is a cluster nobody here recognises,
 * and the honest form of that is silence.
 */
function placement(node: NodeInfo, t: Translate): PeekGroup[] {
  const facts = nodePlacement(node);
  if (!statesPlacement(facts)) return [];

  return [
    {
      title: t("columns", "placement"),
      items: [
        ...(facts.pool
          ? [{ label: t("columns", "pool"), value: facts.pool, mono: true }]
          : []),
        ...(facts.machine
          ? [
              {
                label: t("columns", "instanceType"),
                value: facts.machine,
                mono: true,
              },
            ]
          : []),
        ...(facts.zone
          ? [{ label: t("columns", "zone"), value: facts.zone, mono: true }]
          : []),
        ...(facts.region
          ? [
              {
                label: t("settings", "region"),
                value: facts.region,
                mono: true,
              },
            ]
          : []),
        // Only ever set by a label that says so, and worth the one warn
        // colour on the panel: a node that can vanish on an hour's notice
        // changes what every pod listed under it means.
        ...(facts.spot
          ? [
              {
                label: t("columns", "spot"),
                value: t("empty", "spotReclaim"),
                tone: "warn" as const,
              },
            ]
          : []),
        // From `providerID`'s scheme and nothing else — a pool label can be
        // typed by anyone; this is the cloud signing its work.
        ...(facts.cloud
          ? [{ label: t("columns", "cloud"), value: facts.cloud }]
          : []),
      ],
    },
  ];
}

export const CLUSTER_SOURCES: PeekSources = {
  // What other objects ask of a namespace: whether it is Active, and the
  // labels every namespaceSelector — a listener's allowedRoutes included —
  // matches against.
  Namespace: source(
    (name) => commands.getNamespace(name),
    (ns, _target, t) => ({
      status: ns.status,
      createdAt: ns.createdAt,
      groups: [
        {
          title: t("columns", "labels"),
          count: Object.keys(ns.labels).length || undefined,
          items: Object.entries(ns.labels)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([label, value]) => ({ label, value, mono: true })),
          emptyMessage: t("empty", "nsNoLabelsSelector"),
        },
      ],
    })
  ),

  Node: source(
    (name) => commands.getNode(name),
    (node, _target, t) => ({
      status: nodeReadyWord(node),
      createdAt: node.createdAt,
      groups: [
        {
          title: t("columns", "machine"),
          items: [
            { label: t("columns", "roles"), value: list(node.roles, "worker") },
            { label: t("columns", "kubelet"), value: node.version, mono: true },
            {
              label: t("columns", "platform"),
              value: `${node.os}/${node.arch}`,
              mono: true,
            },
            {
              label: t("columns", "runtime"),
              value: node.containerRuntime,
              mono: true,
            },
            {
              label: t("columns", "internalIp"),
              value: (
                <CopyableAddress
                  value={
                    node.status.addresses.find(
                      (address) => address.type === "InternalIP"
                    )?.address
                  }
                  label={t("columns", "internalIp")}
                />
              ),
            },
          ],
        },
        ...placement(node, t),
        {
          title: t("columns", "capacity"),
          items: [
            { label: "CPU", value: node.allocatable.cpu ?? "—", mono: true },
            {
              label: t("columns", "memory"),
              value: node.allocatable.memory ?? "—",
              mono: true,
            },
            { label: "Pods", value: node.allocatable.pods ?? "—", mono: true },
            {
              label: t("columns", "taints"),
              value: node.taints.length
                ? list(node.taints.map((taint) => taint.key))
                : "none",
              mono: node.taints.length > 0,
              tone: node.taints.length ? "warn" : undefined,
            },
          ],
        },
      ],
    })
  ),

  CustomResourceDefinition: source(
    (name) => commands.getCrd(name),
    (crd, _target, t) => ({
      createdAt: crd.createdAt,
      groups: [
        {
          title: t("nav", "definition"),
          items: [
            { label: t("columns", "group"), value: crd.group, mono: true },
            { label: t("columns", "kind"), value: crd.kind, mono: true },
            { label: t("columns", "scope"), value: crd.scope },
            {
              label: t("nav", "versions"),
              value: list(
                crd.versions
                  .filter((version) => version.served)
                  .map((version) =>
                    version.storage ? `${version.name} (stored)` : version.name
                  )
              ),
              mono: true,
            },
            {
              label: t("columns", "shortNames"),
              value: list(crd.shortNames, "none"),
            },
          ],
        },
      ],
    })
  ),
};
