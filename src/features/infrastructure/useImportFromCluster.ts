import { useCallback, useState } from "react";
import type { Node } from "reactflow";

import { commands } from "@/lib/commands";
import { normalizeTauriError } from "@/lib/error-utils";
import { ResourceType } from "@/lib/resource-registry";
import { useToast } from "@/components/ui/use-toast";
import { useClusterStore } from "@/stores/clusterStore";
import { useInfrastructureBuilderStore } from "@/stores/infrastructureBuilderStore";
import { useT } from "@/i18n/useT";

import type { ResourceNodeData, ServiceResourceData } from "./types";
import { buildEdgesFromResources, podResource } from "./utils";

const GRID_SPACING_X = 260;
const GRID_SPACING_Y = 180;

const layoutPosition = (index: number) => ({
  x: (index % 4) * GRID_SPACING_X,
  y: Math.floor(index / 4) * GRID_SPACING_Y,
});

interface UseImportFromClusterResult {
  importFromCluster: () => Promise<void>;
  isImporting: boolean;
}

/**
 * Pulls live resources (pods, deployments, services, ingresses,
 * configmaps, secrets) from the connected cluster and rewrites the
 * builder canvas to mirror them. On success switches to visual mode.
 */
export function useImportFromCluster(
  onAfterImport?: () => void
): UseImportFromClusterResult {
  const t = useT();
  const { toast } = useToast();
  const { isConnected, currentNamespace } = useClusterStore();
  const { replaceResources } = useInfrastructureBuilderStore();
  const [isImporting, setIsImporting] = useState(false);

  const importFromCluster = useCallback(async () => {
    if (!isConnected) {
      toast({
        title: t("cluster", "notConnected"),
        description: t("cluster", "connectToImport"),
        variant: "destructive",
      });
      return;
    }
    setIsImporting(true);
    const namespaceFilter = currentNamespace || null;

    try {
      const [pods, deployments, services, ingresses, configmaps, secrets] =
        await Promise.all([
          commands.listPods({
            namespace: namespaceFilter,
            labelSelector: null,
            fieldSelector: null,
            limit: null,
            statusFilter: null,
            selector: null,
            nodeName: null,
          }),
          commands.listDeployments({
            namespace: namespaceFilter,
            labelSelector: null,
            fieldSelector: null,
            limit: null,
          }),
          commands.listServices({
            namespace: namespaceFilter,
            labelSelector: null,
            fieldSelector: null,
            limit: null,
            serviceType: null,
          }),
          commands.listIngresses({
            namespace: namespaceFilter,
            labelSelector: null,
            fieldSelector: null,
            limit: null,
          }),
          commands.listConfigmaps({
            namespace: namespaceFilter,
            labelSelector: null,
            fieldSelector: null,
            limit: null,
          }),
          commands.listSecrets({
            namespace: namespaceFilter,
            labelSelector: null,
            fieldSelector: null,
            limit: null,
            secretType: null,
          }),
        ]);

      const resources: ResourceNodeData[] = pods.map(podResource);
      deployments.forEach((deployment) => {
        const container = deployment.containers?.[0];
        resources.push({
          kind: ResourceType.Deployment,
          name: deployment.name,
          namespace: deployment.namespace,
          labels: deployment.labels || {},
          origin: "cluster",
          replicas: deployment.replicas?.desired ?? 1,
          image: container?.image || "nginx:latest",
          ports: container?.ports || [],
          status:
            deployment.replicas?.available >=
            (deployment.replicas?.desired ?? 1)
              ? "Available"
              : "Progressing",
        });
      });
      services.forEach((service) => {
        resources.push({
          kind: ResourceType.Service,
          name: service.name,
          namespace: service.namespace,
          labels: service.labels || {},
          origin: "cluster",
          serviceType: (service.type ||
            "ClusterIP") as ServiceResourceData["serviceType"],
          sessionAffinity:
            service.sessionAffinity && service.sessionAffinity.trim()
              ? (service.sessionAffinity as ServiceResourceData["sessionAffinity"])
              : "None",
          ports: service.ports?.map((port) => port.port) || [],
          selectors: service.selector || {},
        });
      });
      ingresses.forEach((ingress) => {
        const rule = ingress.rules?.[0];
        const path = rule?.paths?.[0];
        const portValue = path?.backendPort ?? "80";
        const port =
          typeof portValue === "number"
            ? portValue
            : Number.parseInt(String(portValue), 10) || 80;
        resources.push({
          kind: ResourceType.Ingress,
          name: ingress.name,
          namespace: ingress.namespace,
          labels: {},
          origin: "cluster",
          host: rule?.host || "",
          path: path?.path || "/",
          pathType:
            path?.pathType && path.pathType.trim()
              ? (path.pathType as "Prefix" | "Exact" | "ImplementationSpecific")
              : "Prefix",
          serviceName: path?.backendService || "",
          servicePort: port,
        });
      });
      configmaps.forEach((configmap) => {
        const data = configmap.dataKeys.reduce<Record<string, string>>(
          (acc, key) => {
            acc[key] = "";
            return acc;
          },
          {}
        );
        resources.push({
          kind: ResourceType.ConfigMap,
          name: configmap.name,
          namespace: configmap.namespace,
          labels: configmap.labels || {},
          origin: "cluster",
          data,
        });
      });
      secrets.forEach((secret) => {
        const data = secret.dataKeys.reduce<Record<string, string>>(
          (acc, key) => {
            acc[key] = "";
            return acc;
          },
          {}
        );
        resources.push({
          kind: ResourceType.Secret,
          name: secret.name,
          namespace: secret.namespace,
          labels: secret.labels || {},
          origin: "cluster",
          secretType: secret.type || "Opaque",
          data,
        });
      });

      const nodes: Node<ResourceNodeData>[] = resources.map(
        (resource, index) => ({
          id: crypto.randomUUID(),
          type: "resource",
          position: layoutPosition(index),
          data: resource,
        })
      );
      const newEdges = buildEdgesFromResources(nodes);
      replaceResources(nodes, newEdges);
      toast({
        title: t("action", "importedFromCluster"),
        description: t("count", "loadedResources", { n: nodes.length }),
      });
      onAfterImport?.();
    } catch (error) {
      toast({
        title: t("settings", "importFailed"),
        description: normalizeTauriError(error),
        variant: "destructive",
      });
    } finally {
      setIsImporting(false);
    }
  }, [
    currentNamespace,
    isConnected,
    replaceResources,
    toast,
    onAfterImport,
    t,
  ]);

  return { importFromCluster, isImporting };
}
