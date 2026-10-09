/**
 * AKS's add-on objects, read as the sentences they are.
 *
 * Two API groups from two unrelated add-ons, one view, because the reader
 * meets them in the same place and neither is big enough to be worth its own
 * anything.
 */

import type { CrdColumn } from "../kit";
import { getValueByPath, matchMultiple, orNone } from "../kit";
import type { CrdView } from "../registry";
import {
  bindingIdentity,
  bindingSelector,
  identityClientId,
  identityResource,
  identityType,
  prohibitedTargetSummary,
} from "./model";

const identityColumns: CrdColumn[] = [
  {
    id: "type",
    header: "type",
    accessor: (resource, t) => identityType(resource, t),
    cell: orNone,
  },
  {
    id: "resource",
    header: "identity",
    accessor: (resource) => identityResource(resource),
    cell: orNone,
  },
  {
    id: "clientId",
    header: "clientId",
    accessor: (resource) => identityClientId(resource),
    cell: orNone,
  },
];

const bindingColumns: CrdColumn[] = [
  {
    id: "identity",
    header: "binds",
    accessor: (resource) => bindingIdentity(resource),
    cell: orNone,
  },
  {
    id: "selector",
    header: "toPodsLabelled",
    accessor: (resource) => {
      const selector = bindingSelector(resource);
      return selector === null ? null : `aadpodidbinding=${selector}`;
    },
    cell: orNone,
  },
];

/**
 * The object the controller creates when a binding actually matched a pod.
 *
 * Included because it is the only one of the four that reports anything, and
 * because it is the answer to "did that binding do anything" — but nothing
 * here reads its *absence* as a failure, which is a different claim and one
 * a cluster whose controller is not running would fail.
 */
const assignedColumns: CrdColumn[] = [
  {
    id: "pod",
    header: "pod",
    accessor: (resource) => getValueByPath(resource, "spec.pod"),
    cell: orNone,
  },
  {
    id: "identity",
    header: "identity",
    accessor: (resource) =>
      getValueByPath(resource, "spec.azureIdentityRef.metadata.name"),
    cell: orNone,
  },
  {
    id: "node",
    header: "node",
    accessor: (resource) => getValueByPath(resource, "spec.nodename"),
    cell: orNone,
  },
  {
    id: "status",
    header: "status",
    accessor: (resource) => getValueByPath(resource, "status.status"),
    cell: orNone,
  },
];

const prohibitedColumns: CrdColumn[] = [
  {
    id: "target",
    header: "leavesAlone",
    accessor: (resource, t) => prohibitedTargetSummary(resource, t),
    cell: orNone,
  },
];

export const crd: CrdView = {
  matches: matchMultiple([
    ["aadpodidentity.k8s.io"],
    ["appgw.ingress.k8s.io", "AzureIngressProhibitedTarget"],
  ]),
  columnsFor: (kind) => {
    switch (kind.toLowerCase()) {
      case "azureidentitybinding":
        return bindingColumns;
      case "azureassignedidentity":
        return assignedColumns;
      case "azureingressprohibitedtarget":
        return prohibitedColumns;
      default:
        return identityColumns;
    }
  },
  // Only one of these four kinds reports anything at all, and it reports it
  // in a column above. A shared status here would have to answer for the
  // three that have none, which it could only do by making something up.
};
