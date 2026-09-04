import { ResourceType } from "@/lib/resource-registry";

export type ResourceKind =
  | typeof ResourceType.Pod
  | typeof ResourceType.Deployment
  | typeof ResourceType.Service
  | typeof ResourceType.Ingress
  | typeof ResourceType.ConfigMap
  | typeof ResourceType.Secret;

export interface BaseResourceData {
  kind: ResourceKind;
  name: string;
  namespace: string;
  labels: Record<string, string>;
  origin?: "builder" | "cluster";
  status?: string;
  rawManifest?: Manifest;
}

/**
 * The slice of a manifest the builder reads and writes.
 *
 * Open on purpose: everything a pasted document carries that the canvas
 * does not show rides along in `rawManifest` and comes back out in the
 * YAML untouched. What is named here is what the canvas shows, not what a
 * Pod is. Numbers may arrive quoted from YAML, so the numeric fields admit
 * a string and are coerced where they are read.
 */
export interface Manifest {
  apiVersion?: string;
  kind?: string;
  metadata?: ObjectMeta;
  spec?: ManifestSpec;
  status?: ManifestStatus;
  data?: Record<string, unknown>;
  type?: string;
  [key: string]: unknown;
}

export interface ObjectMeta {
  name?: string;
  namespace?: string;
  labels?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface Container {
  name?: string;
  image?: string;
  ports?: { containerPort?: number | string; [key: string]: unknown }[];
  [key: string]: unknown;
}

export interface PodTemplate {
  metadata?: ObjectMeta;
  spec?: { containers?: Container[]; [key: string]: unknown };
  [key: string]: unknown;
}

export interface IngressRule {
  host?: string;
  http?: {
    paths?: {
      path?: string;
      pathType?: string;
      backend?: {
        service?: {
          name?: string;
          port?: { number?: number | string; name?: string };
        };
      };
    }[];
  };
}

/** One spec type for the six kinds: a field the kind does not have is simply absent. */
export interface ManifestSpec {
  containers?: Container[];
  replicas?: number | string;
  selector?: Record<string, unknown>;
  template?: PodTemplate;
  type?: string;
  sessionAffinity?: string;
  ports?: { port?: number | string; [key: string]: unknown }[];
  rules?: IngressRule[];
  [key: string]: unknown;
}

export interface ManifestStatus {
  phase?: string;
  availableReplicas?: number | string;
  containerStatuses?: {
    state?: {
      waiting?: { reason?: string };
      terminated?: { reason?: string; exitCode?: number; signal?: number };
    };
  }[];
  [key: string]: unknown;
}

export interface PodResourceData extends BaseResourceData {
  kind: typeof ResourceType.Pod;
  image: string;
  ports: number[];
}

export interface DeploymentResourceData extends BaseResourceData {
  kind: typeof ResourceType.Deployment;
  replicas: number;
  image: string;
  ports: number[];
}

export interface ServiceResourceData extends BaseResourceData {
  kind: typeof ResourceType.Service;
  serviceType: "ClusterIP" | "NodePort" | "LoadBalancer";
  sessionAffinity: "None" | "ClientIP";
  ports: number[];
  selectors: Record<string, string>;
}

export interface IngressResourceData extends BaseResourceData {
  kind: typeof ResourceType.Ingress;
  host: string;
  path: string;
  pathType: "Prefix" | "Exact" | "ImplementationSpecific";
  serviceName: string;
  servicePort: number;
}

export interface ConfigMapResourceData extends BaseResourceData {
  kind: typeof ResourceType.ConfigMap;
  data: Record<string, string>;
}

export interface SecretResourceData extends BaseResourceData {
  kind: typeof ResourceType.Secret;
  secretType: string;
  data: Record<string, string>;
}

export type ResourceNodeData =
  | PodResourceData
  | DeploymentResourceData
  | ServiceResourceData
  | IngressResourceData
  | ConfigMapResourceData
  | SecretResourceData;
