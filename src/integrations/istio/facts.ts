/**
 * What Istio is doing for this cluster right now.
 *
 * The row that had a name and no facts gets them, and they are the three
 * objects the chain is made of rather than a count of every CRD the mesh
 * installs — a reader looking at this row is asking what is routed here, not
 * how many kinds Istio defined.
 */

import type { T } from "@/i18n/useT";
import { integrationPagePath } from "../paths";
import type { VendorFact } from "../registry";
import { fetchMesh } from "./data";
import { hostGroups } from "./model";

export async function facts(): Promise<VendorFact[]> {
  const mesh = await fetchMesh();
  // The pane prints counts; every sentence `hostGroups` composes on the way
  // is discarded here.
  const noWords: T = () => "";
  const groups = hostGroups({ ...mesh, services: [], published: [] }, noWords);

  const lines: VendorFact[] = [
    {
      say: [
        {
          key: "kindCount",
          values: { n: mesh.gateways.length, kind: "Gateway" },
        },
        {
          key: "kindCount",
          values: { n: mesh.virtualServices.length, kind: "VirtualService" },
        },
        {
          key: "kindCount",
          values: { n: mesh.destinationRules.length, kind: "DestinationRule" },
        },
      ],
    },
  ];

  // Only the findings that need no cluster reads: what is behind a route
  // takes two more list calls, and this row is glanced at rather than
  // studied. The page says the rest.
  const unreachable = groups.filter((group) =>
    group.findings.some((finding) => finding.kind === "noGateway")
  ).length;

  if (unreachable > 0) {
    lines.push({
      say: { key: "factHostsNoGateway", values: { n: unreachable } },
      tone: "err",
    });
  } else if (groups.length > 0) {
    lines.push({
      say: { key: "factHostsRouted", values: { n: groups.length } },
    });
  }

  if (groups.length > 0) {
    lines.push({
      say: { key: "factShowThem" },
      to: integrationPagePath("istio"),
    });
  }

  return lines;
}
