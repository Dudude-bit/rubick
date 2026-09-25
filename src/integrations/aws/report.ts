/**
 * What the AWS Load Balancer Controller's own kinds say about one object,
 * reusing `bindingSummary`, `bindingFailure` and `ingressClassParamsSummary`,
 * the same readers the CRD columns use.
 */

import { Waypoints } from "lucide-react";

import { joinSayings } from "@/i18n/say";
import type { T } from "@/i18n/useT";
import type { CustomResourceInfo } from "@/generated/types";
import { iconSvg } from "@/lib/icon-svg";
import { refOf } from "@/lib/report-parts";
import type { ReportSection, ReportValue } from "@/lib/report";
import {
  bindingFailure,
  bindingSummary,
  boundPort,
  boundService,
  ingressClassParamsSummary,
  targetGroupLabel,
} from "./model";

const GROUP = "elbv2.k8s.aws";

function fakeResource(object: {
  namespace: string | null;
  name: string;
  kind: string;
  spec: unknown;
  status: unknown;
}): CustomResourceInfo {
  return {
    name: object.name,
    namespace: object.namespace,
    uid: "",
    apiVersion: `${GROUP}/v1beta1`,
    kind: object.kind,
    spec: object.spec,
    status: object.status,
    labels: {},
    annotations: {},
    createdAt: null,
    ownerReferences: [],
    generation: null,
  };
}

function targetGroupBindingSections(
  object: {
    namespace: string | null;
    name: string;
    kind: string;
    spec: unknown;
    status: unknown;
  },
  t: T
): ReportSection[] {
  const resource = fakeResource(object);
  const service = boundService(resource);
  const port = boundPort(resource);
  const group = targetGroupLabel(resource);
  const failure = bindingFailure(resource);

  const rows: { label: string; values: ReportValue[] }[] = [
    {
      label: t("columns", "status"),
      values: [
        failure
          ? { text: failure, role: "err" }
          : { text: t("share", "awsNoFailure"), quiet: true },
      ],
    },
    {
      label: t("columns", "service"),
      values: service
        ? [
            {
              text: port ? `${service}:${port}` : service,
              ref: refOf({
                kind: "Service",
                name: service,
                namespace: object.namespace,
              }),
            },
          ]
        : [{ text: t("empty", "none"), quiet: true }],
    },
    {
      label: t("share", "awsTargetGroup"),
      values: [{ text: group ?? t("empty", "none"), mono: group !== null }],
    },
    {
      label: t("share", "awsTargets"),
      values: [{ text: joinSayings(bindingSummary(resource), t) }],
    },
  ];

  return [
    {
      id: "aws-targetgroupbinding",
      title: "TargetGroupBinding",
      icon: iconSvg(Waypoints),
      body: { type: "facts", rows },
    },
  ];
}

function ingressClassParamsSections(
  object: {
    namespace: string | null;
    name: string;
    kind: string;
    spec: unknown;
    status: unknown;
  },
  t: T
): ReportSection[] {
  const resource = fakeResource(object);
  return [
    {
      id: "aws-ingressclassparams",
      title: "IngressClassParams",
      icon: iconSvg(Waypoints),
      body: {
        type: "facts",
        rows: [
          {
            label: t("share", "gceApplies"),
            values: [{ text: ingressClassParamsSummary(resource) }],
          },
        ],
      },
    },
  ];
}

export function reportOf(
  object: {
    group: string;
    kind: string;
    namespace: string | null;
    name: string;
    spec: unknown;
    status: unknown;
  },
  t: T
): ReportSection[] | null {
  if (object.group !== GROUP) return null;
  switch (object.kind) {
    case "TargetGroupBinding":
      return targetGroupBindingSections(object, t);
    case "IngressClassParams":
      return ingressClassParamsSections(object, t);
    default:
      return null;
  }
}
