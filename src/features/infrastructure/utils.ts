import { dump, loadAll } from "js-yaml";
import { Edge, Node } from "reactflow";
import type { PodInfo } from "@/generated/types";
import { normalizeTauriError } from "@/lib/error-utils";
import {
  Container,
  IngressRule,
  Manifest,
  ManifestSpec,
  ManifestStatus,
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

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));

/** Labels and data as strings; YAML hands over numbers and booleans too. */
const stringRecord = (value: Record<string, unknown> | undefined) =>
  Object.fromEntries(
    Object.entries(value ?? {})
      .filter(([, item]) =>
        ["string", "number", "boolean"].includes(typeof item)
      )
      .map(([key, item]) => [key, String(item)])
  );

/** A number that may have arrived quoted, or the fallback. */
const count = (value: unknown, fallback: number) => {
  const n = Number(value ?? fallback);
  return Number.isFinite(n) ? n : fallback;
};

const portNumbers = (
  ports: { [key: string]: unknown }[] | undefined,
  key: string
) =>
  (ports ?? []).map((port) => count(port[key], 0)).filter((port) => port > 0);

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
const manifestPodStatus = (status: ManifestStatus | undefined) => {
  const label = containerVerdict(status) ?? status?.phase;
  // Pasted YAML promises nothing about its types; a label is a string or nothing.
  return typeof label === "string" ? label : undefined;
};

/** The lowest container that is waiting for a reason or has died names the pod. */
const containerVerdict = (status: ManifestStatus | undefined) => {
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
    loadAll(text, (raw) => {
      if (!raw) {
        return;
      }
      // A document is anything YAML can spell; only an object can be a manifest.
      const doc = typeof raw === "object" ? (raw as Manifest) : undefined;
      const kind = doc?.kind as ResourceKind | undefined;
      if (!doc || !kind || !RESOURCE_KINDS.includes(kind)) {
        extraManifests.push(raw);
        return;
      }

      const spec = doc.spec ?? {};
      const base = {
        name: String(doc.metadata?.name ?? `${kind.toLowerCase()}-resource`),
        namespace: String(doc.metadata?.namespace ?? ""),
        labels: stringRecord(doc.metadata?.labels),
        origin: "builder" as const,
        rawManifest: doc,
      };

      switch (kind) {
        case ResourceType.Pod: {
          const primary = spec.containers?.[0];
          resources.push({
            ...base,
            kind,
            image: String(primary?.image ?? "nginx:latest"),
            ports: portNumbers(primary?.ports, "containerPort"),
            status: manifestPodStatus(doc.status),
          });
          break;
        }
        case ResourceType.Deployment: {
          const template = spec.template;
          const primary = template?.spec?.containers?.[0];
          const templateLabels = stringRecord(template?.metadata?.labels);
          const desired = count(spec.replicas, 1);
          const available = count(doc.status?.availableReplicas, 0);
          resources.push({
            ...base,
            kind,
            labels: Object.keys(templateLabels).length
              ? templateLabels
              : base.labels,
            replicas: desired,
            image: String(primary?.image ?? "nginx:latest"),
            ports: portNumbers(primary?.ports, "containerPort"),
            status: available >= desired ? "Available" : "Progressing",
          });
          break;
        }
        case ResourceType.Service: {
          resources.push({
            ...base,
            kind,
            serviceType: String(
              spec.type ?? "ClusterIP"
            ) as ServiceResourceData["serviceType"],
            sessionAffinity: String(
              spec.sessionAffinity ?? "None"
            ) as ServiceResourceData["sessionAffinity"],
            ports: portNumbers(spec.ports, "port"),
            selectors: stringRecord(spec.selector),
          });
          break;
        }
        case ResourceType.Ingress: {
          const rule = spec.rules?.[0];
          const path = rule?.http?.paths?.[0];
          const service = path?.backend?.service;
          resources.push({
            ...base,
            kind,
            host: String(rule?.host ?? ""),
            path: String(path?.path ?? "/"),
            pathType: String(
              path?.pathType ?? "Prefix"
            ) as IngressResourceData["pathType"],
            serviceName: String(service?.name ?? ""),
            servicePort: count(
              service?.port?.number ?? service?.port?.name,
              80
            ),
          });
          break;
        }
        case ResourceType.ConfigMap: {
          resources.push({ ...base, kind, data: stringRecord(doc.data) });
          break;
        }
        case ResourceType.Secret: {
          resources.push({
            ...base,
            kind,
            secretType: String(doc.type ?? "Opaque"),
            data: stringRecord(doc.data),
          });
          break;
        }
        default:
          extraManifests.push(raw);
      }
    });
  } catch (error) {
    errors.push(normalizeTauriError(error));
  }

  return { resources, extraManifests, errors };
};

/**
 * The pasted document with the canvas's edits written back over it: the
 * fields the canvas owns are set, and a field the canvas has emptied is
 * removed rather than left as it was.
 */
const manifestBase = (data: ResourceNodeData, kind: ResourceKind): Manifest => {
  const base: Manifest = clone(data.rawManifest ?? {});
  base.apiVersion ??= getApiVersion(kind);
  base.kind = kind;
  const metadata = { ...base.metadata, name: data.name };
  if (data.namespace) metadata.namespace = data.namespace;
  else delete metadata.namespace;
  const labels = filterEmptyRecord(data.labels);
  if (labels) metadata.labels = labels;
  else delete metadata.labels;
  base.metadata = metadata;
  return base;
};

const withPrimary = (
  container: Container | undefined,
  data: { image: string; ports: number[] }
): Container => {
  const next: Container = {
    ...container,
    name: container?.name ?? "app",
    image: data.image || container?.image || "nginx:latest",
  };
  if (data.ports.length)
    next.ports = data.ports.map((containerPort) => ({ containerPort }));
  else delete next.ports;
  return next;
};

const buildPodManifest = (data: PodResourceData) => {
  const base = manifestBase(data, ResourceType.Pod);
  const [primary, ...rest] = base.spec?.containers ?? [];
  base.spec = {
    ...base.spec,
    containers: [withPrimary(primary, data), ...rest],
  };
  return base;
};

const buildDeploymentManifest = (data: DeploymentResourceData) => {
  const base = manifestBase(data, ResourceType.Deployment);
  const matchLabels = filterEmptyRecord(data.labels) ?? { app: data.name };
  const template = base.spec?.template;
  const [primary, ...rest] = template?.spec?.containers ?? [];
  base.spec = {
    ...base.spec,
    replicas: data.replicas,
    selector: { ...base.spec?.selector, matchLabels },
    template: {
      ...template,
      metadata: { ...template?.metadata, labels: matchLabels },
      spec: {
        ...template?.spec,
        containers: [withPrimary(primary, data), ...rest],
      },
    },
  };
  return base;
};

const buildServiceManifest = (data: ServiceResourceData) => {
  const base = manifestBase(data, ResourceType.Service);
  const spec: ManifestSpec = {
    ...base.spec,
    type: data.serviceType,
    sessionAffinity: data.sessionAffinity,
    ports: data.ports.map((port) => ({ port, targetPort: port })),
  };
  const selectors = filterEmptyRecord(data.selectors);
  if (selectors) spec.selector = selectors;
  else delete spec.selector;
  base.spec = spec;
  return base;
};

const buildIngressManifest = (data: IngressResourceData) => {
  const base = manifestBase(data, ResourceType.Ingress);
  const rule: IngressRule = {
    http: {
      paths: [
        {
          path: data.path || "/",
          pathType: data.pathType || "Prefix",
          backend: {
            service: {
              name: data.serviceName || "service",
              port: { number: data.servicePort || 80 },
            },
          },
        },
      ],
    },
  };
  if (data.host) rule.host = data.host;
  base.spec = { ...base.spec, rules: [rule] };
  return base;
};

const buildConfigMapManifest = (data: ConfigMapResourceData) => {
  const base = manifestBase(data, ResourceType.ConfigMap);
  base.data = data.data;
  return base;
};

const buildSecretManifest = (data: SecretResourceData) => {
  const base = manifestBase(data, ResourceType.Secret);
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
