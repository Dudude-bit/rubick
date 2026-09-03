import { dump, loadAll } from "js-yaml";
import { Edge, Node } from "reactflow";
import type { PodInfo } from "@/generated/types";
import { normalizeTauriError } from "@/lib/error-utils";
import {
  ResourceKind,
  ResourceNodeData,
  PodResourceData,
  DeploymentResourceData,
  ServiceResourceData,
  IngressResourceData,
  ConfigMapResourceData,
  SecretResourceData,
} from "./types";
import { ResourceType, getApiVersion } from "@/lib/resource-registry";

export const RESOURCE_KINDS: ResourceKind[] = [
  ResourceType.Pod,
  ResourceType.Deployment,
  ResourceType.Service,
  ResourceType.Ingress,
  ResourceType.ConfigMap,
  ResourceType.Secret,
];

const DEFAULT_NAMESPACE = "default";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));

/** The slice of a Pod's `.status` that names it, as `kubectl get -o yaml` writes it. */
interface PodManifestStatus {
  phase?: string;
  containerStatuses?: {
    state?: {
      waiting?: { reason?: string };
      terminated?: { reason?: string; exitCode?: number; signal?: number };
    };
  }[];
}

/**
 * The status a pasted Pod manifest carries, read the way kubectl reads it.
 *
 * A live pod arrives with kubectl's full derivation done in Rust; a pasted
 * `kubectl get pod -o yaml` has no Rust behind it, and its `.status.phase`
 * says Running for a pod whose only container has crashed six hundred
 * times. Only the first rule of that derivation is applied: the lowest
 * container that is waiting for a reason or has terminated names the pod.
 * Init containers, `deletionTimestamp`, a pod-level reason and a Completed
 * pod with a live sidecar are not read, so such a pod shows its phase
 * where kubectl would say Init:0/2, Terminating, Evicted or Running.
 */
const manifestPodStatus = (status: PodManifestStatus | undefined) => {
  const label = containerVerdict(status) ?? status?.phase;
  // Pasted YAML promises nothing about its types; a label is a string or nothing.
  return typeof label === "string" ? label : undefined;
};

/** The lowest container that is waiting for a reason or has died names the pod. */
const containerVerdict = (status: PodManifestStatus | undefined) => {
  for (const { state } of status?.containerStatuses ?? []) {
    const waiting = state?.waiting?.reason;
    if (waiting && waiting !== "PodInitializing") return waiting;
    const dead = state?.terminated;
    if (!dead) continue;
    if (dead.reason) return dead.reason;
    return dead.signal
      ? `Signal:${dead.signal}`
      : `ExitCode:${dead.exitCode ?? 0}`;
  }
  return undefined;
};

const toStringRecord = (value: unknown): Record<string, string> => {
  if (!isRecord(value)) {
    return {};
  }
  return Object.entries(value).reduce<Record<string, string>>(
    (acc, [key, val]) => {
      if (typeof val === "string") {
        acc[key] = val;
      } else if (typeof val === "number" || typeof val === "boolean") {
        acc[key] = String(val);
      }
      return acc;
    },
    {}
  );
};

const toNumber = (value: unknown, fallback: number) => {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return fallback;
};

const filterEmptyRecord = (value: Record<string, string>) =>
  Object.keys(value).length > 0 ? value : undefined;

const matchesSelector = (
  labels: Record<string, string>,
  selectors: Record<string, string>
) => Object.entries(selectors).every(([key, value]) => labels[key] === value);

export const parsePorts = (value: string) =>
  value
    .split(",")
    .map((part) => Number.parseInt(part.trim(), 10))
    .filter((port) => Number.isFinite(port) && port > 0);

export const formatPorts = (ports: number[]) => ports.join(", ");

export const createDefaultResourceData = (
  kind: ResourceKind,
  name: string,
  namespace: string
): ResourceNodeData => {
  const ns = namespace || DEFAULT_NAMESPACE;
  switch (kind) {
    case ResourceType.Pod:
      return {
        kind,
        name,
        namespace: ns,
        labels: { app: name },
        origin: "builder",
        image: "nginx:latest",
        ports: [80],
      } satisfies PodResourceData;
    case ResourceType.Deployment:
      return {
        kind,
        name,
        namespace: ns,
        labels: { app: name },
        origin: "builder",
        replicas: 1,
        image: "nginx:latest",
        ports: [80],
      } satisfies DeploymentResourceData;
    case ResourceType.Service:
      return {
        kind,
        name,
        namespace: ns,
        labels: { app: name },
        origin: "builder",
        serviceType: "ClusterIP",
        sessionAffinity: "None",
        ports: [80],
        selectors: { app: name },
      } satisfies ServiceResourceData;
    case ResourceType.Ingress:
      return {
        kind,
        name,
        namespace: ns,
        labels: { app: name },
        origin: "builder",
        host: "",
        path: "/",
        pathType: "Prefix",
        serviceName: "",
        servicePort: 80,
      } satisfies IngressResourceData;
    case ResourceType.ConfigMap:
      return {
        kind,
        name,
        namespace: ns,
        labels: { app: name },
        origin: "builder",
        data: { "app.config": "" },
      } satisfies ConfigMapResourceData;
    case ResourceType.Secret:
      return {
        kind,
        name,
        namespace: ns,
        labels: { app: name },
        origin: "builder",
        secretType: "Opaque",
        data: { username: "", password: "" },
      } satisfies SecretResourceData;
  }
  const exhaustive: never = kind;
  throw new Error(`Unsupported resource kind: ${exhaustive}`);
};

export interface ManifestParseResult {
  resources: ResourceNodeData[];
  extraManifests: unknown[];
  errors: string[];
}

export const parseManifestYaml = (text: string): ManifestParseResult => {
  const resources: ResourceNodeData[] = [];
  const extraManifests: unknown[] = [];
  const errors: string[] = [];

  if (!text.trim()) {
    return { resources, extraManifests, errors };
  }

  try {
    loadAll(text, (doc) => {
      if (!doc) {
        return;
      }
      if (!isRecord(doc)) {
        extraManifests.push(doc);
        return;
      }
      const kind = doc.kind as ResourceKind | undefined;
      if (!kind || !RESOURCE_KINDS.includes(kind)) {
        extraManifests.push(doc);
        return;
      }

      const metadata = isRecord(doc.metadata) ? doc.metadata : {};
      const name =
        typeof metadata.name === "string"
          ? metadata.name
          : `${kind.toLowerCase()}-resource`;
      const namespace =
        typeof metadata.namespace === "string" ? metadata.namespace : "";
      const labels = toStringRecord(metadata.labels);
      const rawManifest = doc as Record<string, unknown>;

      switch (kind) {
        case ResourceType.Pod: {
          const spec = isRecord(doc.spec) ? doc.spec : {};
          const containers = Array.isArray(spec.containers)
            ? spec.containers
            : [];
          const primary = isRecord(containers[0]) ? containers[0] : {};
          const ports = Array.isArray(primary.ports)
            ? primary.ports
                .map((port) =>
                  toNumber(isRecord(port) ? port.containerPort : undefined, NaN)
                )
                .filter((port) => Number.isFinite(port))
            : [];
          resources.push({
            kind,
            name,
            namespace,
            labels,
            origin: "builder",
            image:
              typeof primary.image === "string"
                ? primary.image
                : "nginx:latest",
            ports,
            status: manifestPodStatus(
              doc.status as PodManifestStatus | undefined
            ),
            rawManifest,
          });
          break;
        }
        case ResourceType.Deployment: {
          const spec = isRecord(doc.spec) ? doc.spec : {};
          const template = isRecord(spec.template) ? spec.template : {};
          const templateMeta = isRecord(template.metadata)
            ? template.metadata
            : {};
          const templateLabels = toStringRecord(templateMeta.labels);
          const podSpec = isRecord(template.spec) ? template.spec : {};
          const containers = Array.isArray(podSpec.containers)
            ? podSpec.containers
            : [];
          const primary = isRecord(containers[0]) ? containers[0] : {};
          const ports = Array.isArray(primary.ports)
            ? primary.ports
                .map((port) =>
                  toNumber(isRecord(port) ? port.containerPort : undefined, NaN)
                )
                .filter((port) => Number.isFinite(port))
            : [];
          const status = isRecord(doc.status) ? doc.status : {};
          const desired = toNumber(spec.replicas, 1);
          const available = toNumber(status.availableReplicas, 0);
          const statusText = available >= desired ? "Available" : "Progressing";
          resources.push({
            kind,
            name,
            namespace,
            labels: Object.keys(templateLabels).length
              ? templateLabels
              : labels,
            origin: "builder",
            replicas: desired,
            image:
              typeof primary.image === "string"
                ? primary.image
                : "nginx:latest",
            ports,
            status: statusText,
            rawManifest,
          });
          break;
        }
        case ResourceType.Service: {
          const spec = isRecord(doc.spec) ? doc.spec : {};
          const ports = Array.isArray(spec.ports)
            ? spec.ports
                .map((port) =>
                  toNumber(isRecord(port) ? port.port : undefined, NaN)
                )
                .filter((port) => Number.isFinite(port))
            : [];
          resources.push({
            kind,
            name,
            namespace,
            labels,
            origin: "builder",
            serviceType:
              typeof spec.type === "string"
                ? (spec.type as ServiceResourceData["serviceType"])
                : "ClusterIP",
            sessionAffinity:
              typeof spec.sessionAffinity === "string"
                ? (spec.sessionAffinity as ServiceResourceData["sessionAffinity"])
                : "None",
            ports,
            selectors: toStringRecord(spec.selector),
            rawManifest,
          });
          break;
        }
        case ResourceType.Ingress: {
          const spec = isRecord(doc.spec) ? doc.spec : {};
          const rules = Array.isArray(spec.rules) ? spec.rules : [];
          const rule = isRecord(rules[0]) ? rules[0] : {};
          const http = isRecord(rule.http) ? rule.http : {};
          const paths = Array.isArray(http.paths) ? http.paths : [];
          const path = isRecord(paths[0]) ? paths[0] : {};
          const backend = isRecord(path.backend) ? path.backend : {};
          const service = isRecord(backend.service) ? backend.service : {};
          const port = isRecord(service.port) ? service.port : {};
          const host = typeof rule.host === "string" ? rule.host : "";
          const servicePort = toNumber(port.number ?? port.name, 80);
          resources.push({
            kind,
            name,
            namespace,
            labels,
            origin: "builder",
            host,
            path: typeof path.path === "string" ? path.path : "/",
            pathType:
              typeof path.pathType === "string"
                ? (path.pathType as IngressResourceData["pathType"])
                : "Prefix",
            serviceName: typeof service.name === "string" ? service.name : "",
            servicePort,
            rawManifest,
          });
          break;
        }
        case ResourceType.ConfigMap: {
          const data = toStringRecord(doc.data);
          resources.push({
            kind,
            name,
            namespace,
            labels,
            origin: "builder",
            data,
            rawManifest,
          });
          break;
        }
        case ResourceType.Secret: {
          const data = toStringRecord(doc.data);
          resources.push({
            kind,
            name,
            namespace,
            labels,
            origin: "builder",
            secretType: typeof doc.type === "string" ? doc.type : "Opaque",
            data,
            rawManifest,
          });
          break;
        }
        default:
          extraManifests.push(doc);
      }
    });
  } catch (error) {
    errors.push(normalizeTauriError(error));
  }

  return { resources, extraManifests, errors };
};

const withMetadata = (
  base: Record<string, unknown>,
  data: ResourceNodeData
) => {
  const metadata = isRecord(base.metadata) ? { ...base.metadata } : {};
  metadata.name = data.name;
  if (data.namespace) {
    metadata.namespace = data.namespace;
  } else if ("namespace" in metadata) {
    delete metadata.namespace;
  }
  const labels = filterEmptyRecord(data.labels);
  if (labels) {
    metadata.labels = labels;
  } else if ("labels" in metadata) {
    delete metadata.labels;
  }
  base.metadata = metadata;
};

const ensureApiVersion = (
  base: Record<string, unknown>,
  kind: ResourceKind
) => {
  base.apiVersion = base.apiVersion ?? getApiVersion(kind);
};

const buildPodManifest = (data: PodResourceData) => {
  const base = clone(data.rawManifest ?? {});
  ensureApiVersion(base, data.kind);
  base.kind = ResourceType.Pod;
  withMetadata(base, data);
  const spec = isRecord(base.spec) ? { ...base.spec } : {};
  const containers = Array.isArray(spec.containers) ? [...spec.containers] : [];
  const primary = isRecord(containers[0]) ? { ...containers[0] } : {};
  primary.name = typeof primary.name === "string" ? primary.name : "app";
  primary.image =
    data.image ||
    (typeof primary.image === "string" ? primary.image : "nginx:latest");
  if (data.ports.length) {
    primary.ports = data.ports.map((port) => ({ containerPort: port }));
  } else if ("ports" in primary) {
    delete primary.ports;
  }
  spec.containers = [primary, ...containers.slice(1)];
  base.spec = spec;
  return base;
};

const buildDeploymentManifest = (data: DeploymentResourceData) => {
  const base = clone(data.rawManifest ?? {});
  ensureApiVersion(base, data.kind);
  base.kind = ResourceType.Deployment;
  withMetadata(base, data);
  const spec = isRecord(base.spec) ? { ...base.spec } : {};
  spec.replicas = data.replicas;
  const matchLabels = filterEmptyRecord(data.labels) ?? { app: data.name };
  spec.selector = {
    ...(isRecord(spec.selector) ? spec.selector : {}),
    matchLabels,
  };
  const template = isRecord(spec.template) ? { ...spec.template } : {};
  const templateMetadata = isRecord(template.metadata)
    ? { ...template.metadata }
    : {};
  templateMetadata.labels = matchLabels;
  template.metadata = templateMetadata;
  const podSpec = isRecord(template.spec) ? { ...template.spec } : {};
  const containers = Array.isArray(podSpec.containers)
    ? [...podSpec.containers]
    : [];
  const primary = isRecord(containers[0]) ? { ...containers[0] } : {};
  primary.name = typeof primary.name === "string" ? primary.name : "app";
  primary.image =
    data.image ||
    (typeof primary.image === "string" ? primary.image : "nginx:latest");
  if (data.ports.length) {
    primary.ports = data.ports.map((port) => ({ containerPort: port }));
  } else if ("ports" in primary) {
    delete primary.ports;
  }
  podSpec.containers = [primary, ...containers.slice(1)];
  template.spec = podSpec;
  spec.template = template;
  base.spec = spec;
  return base;
};

const buildServiceManifest = (data: ServiceResourceData) => {
  const base = clone(data.rawManifest ?? {});
  ensureApiVersion(base, data.kind);
  base.kind = ResourceType.Service;
  withMetadata(base, data);
  const spec = isRecord(base.spec) ? { ...base.spec } : {};
  spec.type = data.serviceType;
  spec.sessionAffinity = data.sessionAffinity;
  const selectors = filterEmptyRecord(data.selectors);
  if (selectors) {
    spec.selector = selectors;
  } else if ("selector" in spec) {
    delete spec.selector;
  }
  spec.ports = data.ports.map((port) => ({ port, targetPort: port }));
  base.spec = spec;
  return base;
};

const buildIngressManifest = (data: IngressResourceData) => {
  const base = clone(data.rawManifest ?? {});
  ensureApiVersion(base, data.kind);
  base.kind = ResourceType.Ingress;
  withMetadata(base, data);
  const spec = isRecord(base.spec) ? { ...base.spec } : {};
  const backendServiceName = data.serviceName || "service";
  const backendPort = data.servicePort || 80;
  const rule: Record<string, unknown> = {
    http: {
      paths: [
        {
          path: data.path || "/",
          pathType: data.pathType || "Prefix",
          backend: {
            service: {
              name: backendServiceName,
              port: { number: backendPort },
            },
          },
        },
      ],
    },
  };
  if (data.host) {
    rule.host = data.host;
  }
  spec.rules = [rule];
  base.spec = spec;
  return base;
};

const buildConfigMapManifest = (data: ConfigMapResourceData) => {
  const base = clone(data.rawManifest ?? {});
  ensureApiVersion(base, data.kind);
  base.kind = ResourceType.ConfigMap;
  withMetadata(base, data);
  base.data = data.data;
  return base;
};

const buildSecretManifest = (data: SecretResourceData) => {
  const base = clone(data.rawManifest ?? {});
  ensureApiVersion(base, data.kind);
  base.kind = ResourceType.Secret;
  withMetadata(base, data);
  base.type = data.secretType || "Opaque";
  base.data = data.data;
  return base;
};

export const buildManifestYaml = (
  resources: ResourceNodeData[],
  extraManifests: unknown[]
) => {
  const manifests = resources.map((resource) => {
    switch (resource.kind) {
      case ResourceType.Pod:
        return buildPodManifest(resource);
      case ResourceType.Deployment:
        return buildDeploymentManifest(resource);
      case ResourceType.Service:
        return buildServiceManifest(resource);
      case ResourceType.Ingress:
        return buildIngressManifest(resource);
      case ResourceType.ConfigMap:
        return buildConfigMapManifest(resource);
      case ResourceType.Secret:
        return buildSecretManifest(resource);
      default:
        return null;
    }
  });

  const docs = [...manifests, ...extraManifests].filter(Boolean);

  if (!docs.length) {
    return "";
  }

  return docs
    .map((doc) =>
      dump(doc, {
        lineWidth: -1,
        noRefs: true,
        sortKeys: false,
      }).trim()
    )
    .filter(Boolean)
    .join("\n---\n");
};

/**
 * A live pod as a canvas node.
 *
 * The status is the one `kubectl get pod` prints, not `.status.phase`: a pod
 * whose only container is crash-looping is in phase Running, and this canvas
 * used to say so.
 */
export const podResource = (pod: PodInfo): PodResourceData => {
  const container = pod.containers?.[0];
  return {
    kind: ResourceType.Pod,
    name: pod.name,
    namespace: pod.namespace,
    labels: pod.labels || {},
    origin: "cluster",
    image: container?.image || "nginx:latest",
    ports: container?.ports?.map((port) => port.containerPort) || [],
    status: pod.status?.display,
  };
};

export const buildEdgesFromResources = (nodes: Node<ResourceNodeData>[]) => {
  const edges: Edge[] = [];

  nodes.forEach((node) => {
    if (node.data.kind !== ResourceType.Ingress) {
      return;
    }
    const serviceName = node.data.serviceName;
    if (!serviceName) {
      return;
    }
    const target = nodes.find(
      (candidate) =>
        candidate.data.kind === ResourceType.Service &&
        candidate.data.name === serviceName &&
        candidate.data.namespace === node.data.namespace
    );
    if (target) {
      edges.push({
        id: crypto.randomUUID(),
        source: node.id,
        target: target.id,
        type: "smoothstep",
      });
    }
  });

  nodes.forEach((node) => {
    if (node.data.kind !== ResourceType.Service) {
      return;
    }
    const selectors = node.data.selectors;
    if (!selectors || Object.keys(selectors).length === 0) {
      return;
    }
    nodes.forEach((candidate) => {
      if (
        candidate.data.kind !== ResourceType.Pod &&
        candidate.data.kind !== ResourceType.Deployment
      ) {
        return;
      }
      if (matchesSelector(candidate.data.labels, selectors)) {
        edges.push({
          id: crypto.randomUUID(),
          source: node.id,
          target: candidate.id,
          type: "smoothstep",
        });
      }
    });
  });

  return edges;
};
