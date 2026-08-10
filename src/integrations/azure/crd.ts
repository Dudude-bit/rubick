/**
 * AKS's add-on objects, read as the sentences they are.
 *
 * Two API groups from two unrelated add-ons, one view, because the reader
 * meets them in the same place and neither is big enough to be worth its own
 * anything.
 */

import type { CrdColumn } from "../kit";
import { NO_STATUS, getValueByPath, matchMultiple } from "../kit";
import type { CrdView } from "../registry";
import {
  bindingIdentity,
  bindingSelector,
  identityClientId,
  identityResource,
  identityType,
  prohibitedTargetSummary,
} from "./model";

const dash = (value: unknown) =>
  value === null || value === undefined || value === "" ? "—" : String(value);

const identityColumns: CrdColumn[] = [
  {
    id: "type",
    header: "Type",
    accessor: (resource) => identityType(resource),
    cell: dash,
  },
  {
    id: "resource",
    header: "Identity",
    accessor: (resource) => identityResource(resource),
    cell: dash,
  },
  {
    id: "clientId",
    header: "Client ID",
    accessor: (resource) => identityClientId(resource),
    cell: dash,
  },
];

const bindingColumns: CrdColumn[] = [
  {
    id: "identity",
    header: "Binds",
    accessor: (resource) => bindingIdentity(resource),
    cell: dash,
  },
  {
    id: "selector",
    header: "To pods labelled",
    accessor: (resource) => {
      const selector = bindingSelector(resource);
      return selector === null ? null : `aadpodidbinding=${selector}`;
    },
    cell: dash,
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
    header: "Pod",
    accessor: (resource) => getValueByPath(resource, "spec.pod"),
    cell: dash,
  },
  {
    id: "identity",
    header: "Identity",
    accessor: (resource) =>
      getValueByPath(resource, "spec.azureIdentityRef.metadata.name"),
    cell: dash,
  },
  {
    id: "node",
    header: "Node",
    accessor: (resource) => getValueByPath(resource, "spec.nodename"),
    cell: dash,
  },
  {
    id: "status",
    header: "Status",
    accessor: (resource) => getValueByPath(resource, "status.status"),
    cell: dash,
  },
];

const prohibitedColumns: CrdColumn[] = [
  {
    id: "target",
    header: "Leaves alone",
    accessor: (resource) => prohibitedTargetSummary(resource),
    cell: dash,
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
  status: NO_STATUS,
};
