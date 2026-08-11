/**
 * The AWS Load Balancer Controller's objects, drawn as the wire they are.
 *
 * A `TargetGroupBinding` list with a Name and an Age column answers nothing.
 * The three questions somebody opens one for are which Service it attaches,
 * which target group it attaches it to, and whether the controller has
 * complained — so those are the columns.
 */

import type { CrdColumn } from "../kit";
import { conditionStatus, matchByGroup } from "../kit";
import type { CrdView } from "../registry";
import {
  bindingFailure,
  bindingSummary,
  boundPort,
  boundService,
  ingressClassParamsSummary,
  targetGroupLabel,
} from "./model";

const dash = (value: unknown) =>
  value === null || value === undefined || value === "" ? "—" : String(value);

const targetGroupBindingColumns: CrdColumn[] = [
  {
    id: "service",
    header: "Service",
    accessor: (resource) => {
      const service = boundService(resource);
      const port = boundPort(resource);
      return service === null ? null : port ? `${service}:${port}` : service;
    },
    cell: dash,
  },
  {
    id: "targetGroup",
    header: "Target group",
    accessor: (resource) => targetGroupLabel(resource),
    cell: dash,
  },
  {
    id: "targetType",
    header: "Targets",
    accessor: (resource) => bindingSummary(resource),
    cell: dash,
  },
  {
    id: "failure",
    // Not "Status": the column is empty for every healthy binding *and* for
    // every binding on a cluster whose controller is not running, and a
    // header promising status would make that emptiness read as "fine".
    header: "Controller says",
    accessor: (resource) => bindingFailure(resource),
    cell: dash,
  },
];

const ingressClassParamsColumns: CrdColumn[] = [
  {
    id: "applies",
    header: "Applies",
    accessor: (resource) => ingressClassParamsSummary(resource),
    cell: dash,
  },
];

/**
 * All of `elbv2.k8s.aws`.
 *
 * The group is matched whole rather than kind by kind, because everything in
 * it belongs to this one controller and a kind it grows next should fall
 * through to the binding columns rather than to a bare name.
 */
export const crd: CrdView = {
  matches: matchByGroup("elbv2.k8s.aws"),
  columnsFor: (kind) => {
    switch (kind.toLowerCase()) {
      case "ingressclassparams":
        return ingressClassParamsColumns;
      default:
        return targetGroupBindingColumns;
    }
  },
  status: conditionStatus("Ready"),
};
