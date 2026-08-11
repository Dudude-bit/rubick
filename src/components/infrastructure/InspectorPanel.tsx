import { useEffect, useMemo, useState } from "react";
import { Node } from "reactflow";
import {
  ResourceNodeData,
  ServiceResourceData,
} from "@/features/infrastructure/types";
import { formatPorts, parsePorts } from "@/features/infrastructure/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useInfrastructureBuilderStore } from "@/stores/infrastructureBuilderStore";
import { useClusterStore } from "@/stores/clusterStore";
import { useQuery } from "@tanstack/react-query";
import { HelpCircle } from "lucide-react";
import { commands } from "@/lib/commands";
import { normalizeTauriError } from "@/lib/error-utils";
import { ResourceType } from "@/lib/resource-registry";
import { ImageSearchInput } from "./ImageSearchInput";
import { KeyValueRowsEditor, type KeyValueRow } from "./KeyValueRowsEditor";

const SERVICE_TYPE_OPTIONS = ["ClusterIP", "NodePort", "LoadBalancer"] as const;
const SERVICE_SESSION_AFFINITY_OPTIONS = ["None", "ClientIP"] as const;
const INGRESS_PATH_TYPE_OPTIONS = [
  "Prefix",
  "Exact",
  "ImplementationSpecific",
] as const;
const SECRET_TYPE_OPTIONS = [
  "Opaque",
  "kubernetes.io/basic-auth",
  "kubernetes.io/dockerconfigjson",
  "kubernetes.io/tls",
  "kubernetes.io/ssh-auth",
  "kubernetes.io/service-account-token",
] as const;
interface InspectorPanelProps {
  node: Node<ResourceNodeData> | null;
  onUpdate: (nodeId: string, updates: Partial<ResourceNodeData>) => void;
  onRemove: (nodeId: string) => void;
  onOpenYaml: () => void;
}

export function InspectorPanel({
  node,
  onUpdate,
  onRemove,
  onOpenYaml,
}: InspectorPanelProps) {
  const allNodes = useInfrastructureBuilderStore((state) => state.nodes);
  const { isConnected, currentContext, currentNamespace } = useClusterStore();
  const [labelRows, setLabelRows] = useState<KeyValueRow[]>([]);
  const [selectorRows, setSelectorRows] = useState<KeyValueRow[]>([]);
  const [configMapRows, setConfigMapRows] = useState<KeyValueRow[]>([]);
  const [secretRows, setSecretRows] = useState<KeyValueRow[]>([]);
  const [portsText, setPortsText] = useState("");

  const { data: namespaces = [] } = useQuery({
    queryKey: ["namespaces", currentContext],
    queryFn: async () => {
      try {
        const result = await commands.listNamespaces();
        return result.map((ns) => ns.name);
      } catch (err) {
        throw normalizeTauriError(err);
      }
    },
    enabled: isConnected,
  });

  const namespaceOptions = useMemo(() => {
    const unique = Array.from(new Set(namespaces));
    unique.sort();
    return unique;
  }, [namespaces]);

  const rowsToRecord = (rows: KeyValueRow[]) =>
    rows.reduce<Record<string, string>>((acc, row) => {
      const key = row.key.trim();
      if (!key) {
        return acc;
      }
      acc[key] = row.value.trim();
      return acc;
    }, {});

  const recordToRows = (record: Record<string, string>): KeyValueRow[] =>
    Object.entries(record).map(([key, value]) => ({ key, value }));

  const nameConflict = useMemo(() => {
    if (!node) {
      return false;
    }
    const name = node.data.name.trim();
    if (!name) {
      return false;
    }
    const namespace = node.data.namespace.trim() || "default";
    return allNodes.some(
      (candidate) =>
        candidate.id !== node.id &&
        candidate.data.kind === node.data.kind &&
        (candidate.data.namespace.trim() || "default") === namespace &&
        candidate.data.name.trim() === name
    );
  }, [allNodes, node]);

  // Initialise form state ONLY when the selected node changes (by id).
  // Depending on `node` or `node.data` would reset the form on every edit,
  // which is the opposite of what the inspector should do. The setState
  // calls below are a deliberate reset-on-selection-change — `key`-style
  // remount via parent would be cleaner but requires a layout change.
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (!node) {
      return;
    }
    setLabelRows(recordToRows(node.data.labels));
    setSelectorRows(
      node.data.kind === ResourceType.Service
        ? recordToRows(node.data.selectors)
        : []
    );
    setConfigMapRows(
      node.data.kind === ResourceType.ConfigMap
        ? recordToRows(node.data.data)
        : []
    );
    setSecretRows(
      node.data.kind === ResourceType.Secret ? recordToRows(node.data.data) : []
    );
    if (
      node.data.kind === ResourceType.Service ||
      node.data.kind === ResourceType.Pod ||
      node.data.kind === ResourceType.Deployment
    ) {
      setPortsText(formatPorts(node.data.ports));
    } else {
      setPortsText("");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [node?.id]);
  /* eslint-enable react-hooks/set-state-in-effect */

  if (!node) {
    return (
      <div className="border-l border-hair pl-3 text-xs text-fg-mut">
        Select a resource to edit its configuration.
      </div>
    );
  }

  const isPresetSecretType = SECRET_TYPE_OPTIONS.includes(
    node.data.kind === ResourceType.Secret
      ? (node.data.secretType as (typeof SECRET_TYPE_OPTIONS)[number])
      : "Opaque"
  );
  const secretTypeValue =
    node.data.kind === ResourceType.Secret && isPresetSecretType
      ? node.data.secretType
      : "custom";
  const namespaceValue = node.data.namespace.trim();
  const isNamespacePreset = namespaceOptions.includes(namespaceValue);
  const namespaceSelectValue = namespaceValue
    ? isNamespacePreset
      ? namespaceValue
      : "__custom__"
    : "__inherit__";
  const showNamespaceInput =
    !isConnected ||
    namespaceOptions.length === 0 ||
    namespaceSelectValue === "__custom__";

  return (
    // Column, not card: the hairline down its left edge is the only thing
    // separating the inspector from the canvas beside it.
    <div className="flex flex-col gap-4 border-l border-hair pl-3">
      <div>
        <h3 className="text-[13px] font-semibold tracking-tight text-fg">
          {node.data.kind}
        </h3>
        <p className="text-[11px] text-fg-mut">
          Core fields here; switch to YAML for anything else.
        </p>
      </div>

      <div className="space-y-3">
        <div className="space-y-1.5">
          <Label
            htmlFor="resource-name"
            className="text-[11px] font-normal text-fg-mut"
          >
            Name
          </Label>
          <Input
            id="resource-name"
            value={node.data.name}
            className={
              nameConflict ? "border-err focus-visible:ring-err" : undefined
            }
            onChange={(event) =>
              onUpdate(node.id, { name: event.target.value })
            }
          />
          {nameConflict && (
            <p className="text-[11px] text-err">
              Name already used for a {node.data.kind} in this namespace.
            </p>
          )}
        </div>
        <div className="space-y-1.5">
          <Label
            htmlFor="resource-namespace"
            className="text-[11px] font-normal text-fg-mut"
          >
            Namespace
          </Label>
          {isConnected && namespaceOptions.length > 0 ? (
            <>
              <Select
                value={namespaceSelectValue}
                onValueChange={(value) => {
                  if (value === "__inherit__") {
                    onUpdate(node.id, { namespace: "" });
                    return;
                  }
                  if (value === "__custom__") {
                    return;
                  }
                  onUpdate(node.id, { namespace: value });
                }}
              >
                <SelectTrigger id="resource-namespace">
                  <SelectValue
                    placeholder={
                      currentNamespace
                        ? `Use current (${currentNamespace})`
                        : "Use current context"
                    }
                  />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__inherit__">
                    Use current context
                    {currentNamespace ? ` (${currentNamespace})` : ""}
                  </SelectItem>
                  {namespaceOptions.map((ns) => (
                    <SelectItem key={ns} value={ns}>
                      {ns}
                    </SelectItem>
                  ))}
                  <SelectItem value="__custom__">Custom...</SelectItem>
                </SelectContent>
              </Select>
              {showNamespaceInput && (
                <Input
                  id="resource-namespace-custom"
                  placeholder="custom namespace"
                  value={node.data.namespace}
                  onChange={(event) =>
                    onUpdate(node.id, { namespace: event.target.value })
                  }
                />
              )}
            </>
          ) : (
            <Input
              id="resource-namespace"
              placeholder="default"
              value={node.data.namespace}
              onChange={(event) =>
                onUpdate(node.id, { namespace: event.target.value })
              }
            />
          )}
        </div>
        <div className="space-y-1.5">
          <Label
            htmlFor="resource-labels"
            className="text-[11px] font-normal text-fg-mut"
          >
            Labels
          </Label>
          <KeyValueRowsEditor
            rows={labelRows}
            onChange={(next) => {
              setLabelRows(next);
              onUpdate(node.id, { labels: rowsToRecord(next) });
            }}
            itemLabel="label"
          />
        </div>
      </div>

      {node.data.kind === ResourceType.Pod && (
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label
              htmlFor="pod-image"
              className="text-[11px] font-normal text-fg-mut"
            >
              Container Image
            </Label>
            <ImageSearchInput
              id="pod-image"
              value={node.data.image}
              onChange={(value) => onUpdate(node.id, { image: value })}
              placeholder="nginx:latest"
            />
          </div>
          <div className="space-y-1.5">
            <Label
              htmlFor="pod-ports"
              className="text-[11px] font-normal text-fg-mut"
            >
              Ports
            </Label>
            <Input
              id="pod-ports"
              placeholder="80, 443"
              value={portsText}
              onChange={(event) => {
                const value = event.target.value;
                setPortsText(value);
                onUpdate(node.id, { ports: parsePorts(value) });
              }}
            />
          </div>
        </div>
      )}

      {node.data.kind === ResourceType.Deployment && (
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label
              htmlFor="deployment-replicas"
              className="text-[11px] font-normal text-fg-mut"
            >
              Replicas
            </Label>
            <Input
              id="deployment-replicas"
              type="number"
              min={0}
              value={node.data.replicas}
              onChange={(event) =>
                onUpdate(node.id, {
                  replicas: Number.parseInt(event.target.value, 10) || 0,
                })
              }
            />
          </div>
          <div className="space-y-1.5">
            <Label
              htmlFor="deployment-image"
              className="text-[11px] font-normal text-fg-mut"
            >
              Container Image
            </Label>
            <ImageSearchInput
              id="deployment-image"
              value={node.data.image}
              onChange={(value) => onUpdate(node.id, { image: value })}
              placeholder="nginx:latest"
            />
          </div>
          <div className="space-y-1.5">
            <Label
              htmlFor="deployment-ports"
              className="text-[11px] font-normal text-fg-mut"
            >
              Ports
            </Label>
            <Input
              id="deployment-ports"
              placeholder="80, 443"
              value={portsText}
              onChange={(event) => {
                const value = event.target.value;
                setPortsText(value);
                onUpdate(node.id, { ports: parsePorts(value) });
              }}
            />
          </div>
        </div>
      )}

      {node.data.kind === ResourceType.Service && (
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label className="text-[11px] font-normal text-fg-mut">
              Service Type
            </Label>
            <Select
              value={node.data.serviceType}
              onValueChange={(value) =>
                onUpdate(node.id, {
                  serviceType: value as ServiceResourceData["serviceType"],
                })
              }
            >
              <SelectTrigger>
                <SelectValue placeholder="Select type" />
              </SelectTrigger>
              <SelectContent>
                {SERVICE_TYPE_OPTIONS.map((type) => (
                  <SelectItem key={type} value={type}>
                    {type}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <div className="flex items-center gap-2">
              <Label className="text-[11px] font-normal text-fg-mut">
                Session Affinity
              </Label>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    className="text-fg-fnt hover:text-fg-mut"
                  >
                    <HelpCircle className="h-3.5 w-3.5" />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="top">
                  Routes client requests to the same backend when set to
                  ClientIP.
                </TooltipContent>
              </Tooltip>
            </div>
            <Select
              value={node.data.sessionAffinity}
              onValueChange={(value) =>
                onUpdate(node.id, {
                  sessionAffinity:
                    value as ServiceResourceData["sessionAffinity"],
                })
              }
            >
              <SelectTrigger>
                <SelectValue placeholder="Select affinity" />
              </SelectTrigger>
              <SelectContent>
                {SERVICE_SESSION_AFFINITY_OPTIONS.map((option) => (
                  <SelectItem key={option} value={option}>
                    {option}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label
              htmlFor="service-ports"
              className="text-[11px] font-normal text-fg-mut"
            >
              Ports
            </Label>
            <Input
              id="service-ports"
              placeholder="80, 443"
              value={portsText}
              onChange={(event) => {
                const value = event.target.value;
                setPortsText(value);
                onUpdate(node.id, { ports: parsePorts(value) });
              }}
            />
          </div>
          <div className="space-y-1.5">
            <Label
              htmlFor="service-selectors"
              className="text-[11px] font-normal text-fg-mut"
            >
              Selectors
            </Label>
            <KeyValueRowsEditor
              rows={selectorRows}
              onChange={(next) => {
                setSelectorRows(next);
                onUpdate(node.id, { selectors: rowsToRecord(next) });
              }}
              itemLabel="selector"
            />
          </div>
        </div>
      )}

      {node.data.kind === ResourceType.Ingress && (
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label
              htmlFor="ingress-host"
              className="text-[11px] font-normal text-fg-mut"
            >
              Host
            </Label>
            <Input
              id="ingress-host"
              placeholder="example.com"
              value={node.data.host}
              onChange={(event) =>
                onUpdate(node.id, { host: event.target.value })
              }
            />
          </div>
          <div className="space-y-1.5">
            <Label
              htmlFor="ingress-path"
              className="text-[11px] font-normal text-fg-mut"
            >
              Path
            </Label>
            <Input
              id="ingress-path"
              placeholder="/"
              value={node.data.path}
              onChange={(event) =>
                onUpdate(node.id, { path: event.target.value })
              }
            />
          </div>
          <div className="space-y-1.5">
            <div className="flex items-center gap-2">
              <Label className="text-[11px] font-normal text-fg-mut">
                Path Type
              </Label>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    className="text-fg-fnt hover:text-fg-mut"
                  >
                    <HelpCircle className="h-3.5 w-3.5" />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="top">
                  Controls how the path is matched (Prefix, Exact, or
                  ImplementationSpecific).
                </TooltipContent>
              </Tooltip>
            </div>
            <Select
              value={node.data.pathType}
              onValueChange={(value) =>
                onUpdate(node.id, {
                  pathType: value as (typeof INGRESS_PATH_TYPE_OPTIONS)[number],
                })
              }
            >
              <SelectTrigger>
                <SelectValue placeholder="Select path type" />
              </SelectTrigger>
              <SelectContent>
                {INGRESS_PATH_TYPE_OPTIONS.map((type) => (
                  <SelectItem key={type} value={type}>
                    {type}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label
              htmlFor="ingress-service"
              className="text-[11px] font-normal text-fg-mut"
            >
              Backend Service
            </Label>
            <Input
              id="ingress-service"
              placeholder="service-name"
              value={node.data.serviceName}
              onChange={(event) =>
                onUpdate(node.id, { serviceName: event.target.value })
              }
            />
          </div>
          <div className="space-y-1.5">
            <Label
              htmlFor="ingress-port"
              className="text-[11px] font-normal text-fg-mut"
            >
              Backend Port
            </Label>
            <Input
              id="ingress-port"
              type="number"
              min={1}
              value={node.data.servicePort}
              onChange={(event) =>
                onUpdate(node.id, {
                  servicePort: Number.parseInt(event.target.value, 10) || 80,
                })
              }
            />
          </div>
        </div>
      )}

      {node.data.kind === ResourceType.ConfigMap && (
        <div className="space-y-1.5">
          <Label className="text-[11px] font-normal text-fg-mut">Data</Label>
          <KeyValueRowsEditor
            rows={configMapRows}
            onChange={(next) => {
              setConfigMapRows(next);
              onUpdate(node.id, { data: rowsToRecord(next) });
            }}
            itemLabel="entry"
          />
        </div>
      )}

      {node.data.kind === ResourceType.Secret && (
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label
              htmlFor="secret-type"
              className="text-[11px] font-normal text-fg-mut"
            >
              Secret Type
            </Label>
            <Select
              value={secretTypeValue}
              onValueChange={(value) => {
                if (value === "custom") {
                  if (isPresetSecretType) {
                    onUpdate(node.id, { secretType: "" });
                  }
                  return;
                }
                onUpdate(node.id, { secretType: value });
              }}
            >
              <SelectTrigger id="secret-type">
                <SelectValue placeholder="Select type" />
              </SelectTrigger>
              <SelectContent>
                {SECRET_TYPE_OPTIONS.map((type) => (
                  <SelectItem key={type} value={type}>
                    {type}
                  </SelectItem>
                ))}
                <SelectItem value="custom">Custom</SelectItem>
              </SelectContent>
            </Select>
            {secretTypeValue === "custom" && (
              <Input
                id="secret-type-custom"
                placeholder="custom secret type"
                value={isPresetSecretType ? "" : node.data.secretType}
                onChange={(event) =>
                  onUpdate(node.id, { secretType: event.target.value })
                }
              />
            )}
          </div>
          <div className="space-y-1.5">
            <Label className="text-[11px] font-normal text-fg-mut">Data</Label>
            <KeyValueRowsEditor
              rows={secretRows}
              onChange={(next) => {
                setSecretRows(next);
                onUpdate(node.id, { data: rowsToRecord(next) });
              }}
              itemLabel="entry"
            />
          </div>
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        <Button variant="outline" size="sm" onClick={onOpenYaml}>
          Open YAML
        </Button>
        <Button
          variant="destructive"
          size="sm"
          onClick={() => onRemove(node.id)}
        >
          Remove Resource
        </Button>
      </div>
    </div>
  );
}
