/**
 * What AKS's add-on kinds say about one object, reusing `identityType`,
 * `identityResource`, `bindingIdentity`, `bindingSelector` and
 * `prohibitedTargetSummary`, the same readers the CRD columns use.
 *
 * `danglingBindings` is not attempted here: it needs every `AzureIdentity`
 * in the cluster to say whether a binding's identity is missing, which
 * `object.report` does not have. The binding still names the identity it
 * points at, as a link, with no claim about whether it exists.
 */

import { KeyRound } from "lucide-react";

import type { T } from "@/i18n/useT";
import type { CustomResourceInfo } from "@/generated/types";
import { iconSvg } from "@/lib/icon-svg";
import { refOf } from "@/lib/report-parts";
import type { ReportSection, ReportValue } from "@/lib/report";
import { getValueByPath } from "../kit";
import {
  bindingIdentity,
  bindingSelector,
  identityClientId,
  identityResource,
  identityType,
  prohibitedTargetSummary,
} from "./model";

const AAD_GROUP = "aadpodidentity.k8s.io";
const AGIC_GROUP = "appgw.ingress.k8s.io";

function fakeResource(object: {
  namespace: string | null;
  name: string;
  kind: string;
  group: string;
  spec: unknown;
  status: unknown;
}): CustomResourceInfo {
  return {
    name: object.name,
    namespace: object.namespace,
    uid: "",
    apiVersion: `${object.group}/v1`,
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

function identitySections(resource: CustomResourceInfo, t: T): ReportSection[] {
  const type = identityType(resource, t);
  const clientId = identityClientId(resource);
  const azureResource = identityResource(resource);
  const rows: { label: string; values: ReportValue[] }[] = [
    {
      label: t("share", "azureType"),
      values: [
        type ? { text: type } : { text: t("empty", "none"), quiet: true },
      ],
    },
  ];
  if (azureResource)
    rows.push({
      label: t("share", "azureResource"),
      values: [{ text: azureResource, mono: true }],
    });
  if (clientId)
    rows.push({ label: "clientID", values: [{ text: clientId, mono: true }] });
  return [
    {
      id: "azure-identity",
      title: "AzureIdentity",
      icon: iconSvg(KeyRound),
      body: { type: "facts", rows },
    },
  ];
}

function identityBindingSections(
  resource: CustomResourceInfo,
  namespace: string | null,
  t: T
): ReportSection[] {
  const identity = bindingIdentity(resource);
  const selector = bindingSelector(resource);
  const rows: { label: string; values: ReportValue[] }[] = [
    {
      label: t("share", "azureBindsIdentity"),
      values: identity
        ? [
            {
              text: identity,
              ref: refOf({ kind: "AzureIdentity", name: identity, namespace }),
            },
          ]
        : [{ text: t("empty", "none"), quiet: true }],
    },
    {
      label: t("share", "azureToPods"),
      values: [
        selector
          ? { text: `aadpodidbinding=${selector}`, mono: true }
          : { text: t("empty", "none"), quiet: true },
      ],
    },
  ];
  return [
    {
      id: "azure-identitybinding",
      title: "AzureIdentityBinding",
      icon: iconSvg(KeyRound),
      body: { type: "facts", rows },
    },
  ];
}

function assignedIdentitySections(
  resource: CustomResourceInfo,
  namespace: string | null,
  t: T
): ReportSection[] {
  const pod = getValueByPath(resource, "spec.pod");
  const identity = getValueByPath(
    resource,
    "spec.azureIdentityRef.metadata.name"
  );
  const node = getValueByPath(resource, "spec.nodename");
  const status = getValueByPath(resource, "status.status");
  const rows: { label: string; values: ReportValue[] }[] = [
    {
      label: t("columns", "status"),
      values: [
        typeof status === "string" && status !== ""
          ? { text: status }
          : { text: t("share", "notWrittenYet"), quiet: true },
      ],
    },
    {
      label: t("columns", "pods"),
      values: [
        typeof pod === "string" && pod !== ""
          ? { text: pod, ref: refOf({ kind: "Pod", name: pod, namespace }) }
          : { text: t("empty", "none"), quiet: true },
      ],
    },
    {
      label: t("share", "azureBindsIdentity"),
      values: [
        typeof identity === "string" && identity !== ""
          ? {
              text: identity,
              ref: refOf({ kind: "AzureIdentity", name: identity, namespace }),
            }
          : { text: t("empty", "none"), quiet: true },
      ],
    },
  ];
  if (typeof node === "string" && node !== "") {
    rows.push({
      label: t("columns", "node"),
      values: [
        {
          text: node,
          ref: refOf({ kind: "Node", name: node, namespace: null }),
        },
      ],
    });
  }
  return [
    {
      id: "azure-assignedidentity",
      title: "AzureAssignedIdentity",
      icon: iconSvg(KeyRound),
      body: { type: "facts", rows },
    },
  ];
}

function prohibitedTargetSections(
  resource: CustomResourceInfo,
  t: T
): ReportSection[] {
  return [
    {
      id: "azure-prohibitedtarget",
      title: "AzureIngressProhibitedTarget",
      icon: iconSvg(KeyRound),
      body: {
        type: "facts",
        rows: [
          {
            label: t("share", "azureLeavesAlone"),
            values: [{ text: prohibitedTargetSummary(resource, t) }],
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
  const resource = fakeResource(object);
  if (object.group === AAD_GROUP) {
    switch (object.kind) {
      case "AzureIdentity":
        return identitySections(resource, t);
      case "AzureIdentityBinding":
        return identityBindingSections(resource, object.namespace, t);
      case "AzureAssignedIdentity":
        return assignedIdentitySections(resource, object.namespace, t);
      default:
        return null;
    }
  }
  if (
    object.group === AGIC_GROUP &&
    object.kind === "AzureIngressProhibitedTarget"
  ) {
    return prohibitedTargetSections(resource, t);
  }
  return null;
}
