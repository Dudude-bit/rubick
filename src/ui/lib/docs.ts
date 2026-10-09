import { toKind, type ResourceKind } from "@/lib/resource-registry";

/** The project has no documentation site; the README is the manual. */
export const RUBICK_DOCS = "https://github.com/Dudude-bit/rubick#readme";

const K8S = "https://kubernetes.io/docs/";

/** Where kubernetes.io explains each kind. Keyed by kind, so a new one does not compile without a page. */
const KIND_DOCS: Record<ResourceKind, string> = {
  Pod: "concepts/workloads/pods/",
  Deployment: "concepts/workloads/controllers/deployment/",
  ReplicaSet: "concepts/workloads/controllers/replicaset/",
  StatefulSet: "concepts/workloads/controllers/statefulset/",
  DaemonSet: "concepts/workloads/controllers/daemonset/",
  Job: "concepts/workloads/controllers/job/",
  CronJob: "concepts/workloads/controllers/cron-jobs/",
  ConfigMap: "concepts/configuration/configmap/",
  Secret: "concepts/configuration/secret/",
  Service: "concepts/services-networking/service/",
  Ingress: "concepts/services-networking/ingress/",
  NetworkPolicy: "concepts/services-networking/network-policies/",
  Gateway: "concepts/services-networking/gateway/",
  GatewayClass: "concepts/services-networking/gateway/",
  HTTPRoute: "concepts/services-networking/gateway/",
  GRPCRoute: "concepts/services-networking/gateway/",
  TLSRoute: "concepts/services-networking/gateway/",
  TCPRoute: "concepts/services-networking/gateway/",
  UDPRoute: "concepts/services-networking/gateway/",
  PersistentVolumeClaim: "concepts/storage/persistent-volumes/",
  PersistentVolume: "concepts/storage/persistent-volumes/",
  StorageClass: "concepts/storage/storage-classes/",
  Endpoints: "concepts/services-networking/endpoint-slices/",
  Node: "concepts/architecture/nodes/",
  // No concept page of its own; the API reference says what one holds.
  Event: "reference/kubernetes-api/core/event-v1/",
  Namespace: "concepts/overview/working-with-objects/namespaces/",
  HorizontalPodAutoscaler:
    "concepts/workloads/autoscaling/horizontal-pod-autoscale/",
  PodDisruptionBudget: "concepts/workloads/pods/disruptions/",
  CustomResourceDefinition:
    "concepts/extend-kubernetes/api-extension/custom-resources/",
};

/** Built-in kinds with no page of their own, which the generic list still explains. */
const ACCESS_DOCS = {
  ServiceAccount: "concepts/security/service-accounts/",
  Role: "reference/access-authn-authz/rbac/",
  RoleBinding: "reference/access-authn-authz/rbac/",
  ClusterRole: "reference/access-authn-authz/rbac/",
  ClusterRoleBinding: "reference/access-authn-authz/rbac/",
};

/** A kind with a sentence in `kindAbout` and a page on kubernetes.io. */
export type ExplainedKind = ResourceKind | keyof typeof ACCESS_DOCS;

const DOCS: Record<ExplainedKind, string> = { ...KIND_DOCS, ...ACCESS_DOCS };

export function isExplained(kind: string): kind is ExplainedKind {
  return Object.hasOwn(DOCS, kind);
}

export function kindDocs(kind: ExplainedKind): string {
  return K8S + DOCS[kind];
}

/** The kind a page is about, from its address: its list, or one object of it. */
export function kindOfPath(pathname: string): ResourceKind | null {
  const segment = pathname.split("/").filter(Boolean)[2];
  return segment ? toKind(decodeURIComponent(segment)) : null;
}
