import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactFlow, {
  Background,
  Controls,
  MiniMap,
  ReactFlowInstance,
  Connection,
  Node,
  Edge,
  SelectionMode,
  type OnSelectionChangeParams,
} from "reactflow";
import "reactflow/dist/style.css";
import CodeMirror from "@uiw/react-codemirror";
import { yaml as yamlLanguage } from "@codemirror/lang-yaml";
import { useToast } from "@/components/ui/use-toast";
import { useClusterStore } from "@/stores/clusterStore";
import { useThemeStore } from "@/stores/themeStore";
import { useInfrastructureBuilderStore } from "@/stores/infrastructureBuilderStore";
import { ResourceNode } from "@/components/infrastructure/ResourceNode";
import { ResourcePalette } from "@/components/infrastructure/ResourcePalette";
import { InspectorPanel } from "@/components/infrastructure/InspectorPanel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ConnectClusterEmptyState } from "@/components/ui/connect-cluster-empty-state";
import { SectionHeader } from "@/components/ui/section";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Spinner } from "@/components/ui/spinner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { buildManifestYaml } from "@/features/infrastructure/utils";
import {
  ResourceKind,
  ResourceNodeData,
} from "@/features/infrastructure/types";
import { useImportFromCluster } from "@/features/infrastructure/useImportFromCluster";
import { applyInfrastructureTemplate } from "@/features/infrastructure/templates";
import { usePaletteDragDrop } from "@/features/infrastructure/usePaletteDragDrop";
import { useBuilderKeyboardShortcuts } from "@/features/infrastructure/useBuilderKeyboardShortcuts";
import {
  RefreshCw,
  CheckCircle2,
  Play,
  AlertTriangle,
  Trash2,
  HelpCircle,
} from "lucide-react";
import { commands } from "@/lib/commands";
import { normalizeTauriError } from "@/lib/error-utils";
import { ResourceType } from "@/lib/resource-registry";
import { cn } from "@/lib/utils";
import { useT } from "@/i18n/useT";

const LOCAL_CONTEXT = "__local__";

const isValidConnection = (source: ResourceKind, target: ResourceKind) => {
  if (source === ResourceType.Ingress && target === ResourceType.Service) {
    return true;
  }
  if (
    source === ResourceType.Service &&
    (target === ResourceType.Pod || target === ResourceType.Deployment)
  ) {
    return true;
  }
  return false;
};

export function InfrastructureBuilder() {
  const t = useT();
  const { toast } = useToast();
  const { isConnected, currentContext, currentNamespace } = useClusterStore();
  const theme = useThemeStore((state) => state.theme);
  const {
    nodes,
    edges,
    yamlText,
    extraManifests,
    selectedNodeId,
    setContext,
    setYamlText,
    setNodes,
    setEdges,
    setSelectedNodeId,
    onNodesChange,
    onEdgesChange,
    onConnect,
    addResource,
    updateNode,
    removeNode,
    clearCanvas,
    syncFromYaml,
    syncToYaml,
  } = useInfrastructureBuilderStore();
  const [mode, setMode] = useState<"visual" | "yaml">("visual");
  const [filter, setFilter] = useState("");
  const [reactFlowInstance, setReactFlowInstance] =
    useState<ReactFlowInstance | null>(null);
  const [isApplying, setIsApplying] = useState(false);
  const [isValidating, setIsValidating] = useState(false);
  const [clearOpen, setClearOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [includeImported, setIncludeImported] = useState(false);
  const [selection, setSelection] = useState<{
    nodes: Node<ResourceNodeData>[];
    edges: Edge[];
  }>({
    nodes: [],
    edges: [],
  });
  const [lastResult, setLastResult] = useState<{
    title: string;
    message: string;
    success: boolean;
  } | null>(null);
  const reactFlowWrapper = useRef<HTMLDivElement>(null);
  const addCounterRef = useRef(0);

  const editorTheme = useMemo(() => {
    if (theme === "dark") {
      return "dark";
    }
    if (theme === "light") {
      return "light";
    }
    if (
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-color-scheme: dark)").matches
    ) {
      return "dark";
    }
    return "light";
  }, [theme]);

  useEffect(() => {
    setContext(currentContext ?? LOCAL_CONTEXT);
  }, [currentContext, setContext]);

  const selectedNode = useMemo(
    () => nodes.find((node) => node.id === selectedNodeId) ?? null,
    [nodes, selectedNodeId]
  );

  const nodeTypes = useMemo(() => ({ resource: ResourceNode }), []);

  const visibleNodes = useMemo(() => {
    if (!filter.trim()) {
      return nodes;
    }
    const term = filter.toLowerCase();
    return nodes.map((node) => {
      const haystack =
        `${node.data.kind} ${node.data.name} ${node.data.namespace}`.toLowerCase();
      return { ...node, hidden: !haystack.includes(term) };
    });
  }, [nodes, filter]);

  const toFlowPosition = useCallback(
    (point: { x: number; y: number }) => {
      if (!reactFlowInstance || !reactFlowWrapper.current) {
        return { x: 0, y: 0 };
      }
      const bounds = reactFlowWrapper.current.getBoundingClientRect();
      const screenToFlowPosition = (
        reactFlowInstance as ReactFlowInstance & {
          screenToFlowPosition?: (pos: { x: number; y: number }) => {
            x: number;
            y: number;
          };
        }
      ).screenToFlowPosition;
      if (screenToFlowPosition) {
        return screenToFlowPosition(point);
      }
      return reactFlowInstance.project({
        x: point.x - bounds.left,
        y: point.y - bounds.top,
      });
    },
    [reactFlowInstance]
  );

  const { handlePalettePointerDown, suppressClickRef } = usePaletteDragDrop({
    reactFlowWrapper,
    toFlowPosition,
    addResource,
    currentNamespace,
  });

  const handleAddResource = useCallback(
    (kind: ResourceKind) => {
      let base = { x: 0, y: 0 };
      if (reactFlowWrapper.current) {
        const bounds = reactFlowWrapper.current.getBoundingClientRect();
        base = toFlowPosition({
          x: bounds.left + bounds.width / 2,
          y: bounds.top + bounds.height / 2,
        });
      }
      const offsetIndex = addCounterRef.current % 9;
      const position = {
        x: base.x + ((offsetIndex % 3) - 1) * 220,
        y: base.y + (Math.floor(offsetIndex / 3) - 1) * 160,
      };
      addCounterRef.current += 1;
      addResource(kind, position, currentNamespace || "default");
    },
    [addResource, currentNamespace, toFlowPosition]
  );

  const handlePaletteClick = useCallback(
    (kind: ResourceKind) => {
      if (suppressClickRef.current) {
        suppressClickRef.current = false;
        return;
      }
      handleAddResource(kind);
    },
    [handleAddResource, suppressClickRef]
  );

  const handleSelectionChange = useCallback(
    (params: OnSelectionChangeParams) => {
      const nextNodes = params.nodes ?? [];
      const nextEdges = params.edges ?? [];
      setSelection({ nodes: nextNodes, edges: nextEdges });
      if (nextNodes.length === 1 && nextEdges.length === 0) {
        setSelectedNodeId(nextNodes[0].id);
      } else {
        setSelectedNodeId(null);
      }
    },
    [setSelectedNodeId]
  );

  const handleDeleteSelection = useCallback(() => {
    if (selection.nodes.length === 0 && selection.edges.length === 0) {
      return;
    }
    const nodeIds = new Set(selection.nodes.map((node) => node.id));
    const edgeIds = new Set(selection.edges.map((edge) => edge.id));
    const nextNodes = nodes.filter((node) => !nodeIds.has(node.id));
    const nextEdges = edges.filter(
      (edge) =>
        !edgeIds.has(edge.id) &&
        !nodeIds.has(edge.source) &&
        !nodeIds.has(edge.target)
    );
    setNodes(nextNodes);
    setEdges(nextEdges);
    setSelection({ nodes: [], edges: [] });
    setSelectedNodeId(null);
  }, [edges, nodes, selection, setEdges, setNodes, setSelectedNodeId]);

  const handleClearCanvas = useCallback(() => {
    clearCanvas();
    setSelection({ nodes: [], edges: [] });
    addCounterRef.current = 0;
  }, [clearCanvas]);

  useBuilderKeyboardShortcuts({
    enabled: mode === "visual",
    nodes,
    edges,
    setNodes,
    setEdges,
    setSelection,
    onDeleteSelection: handleDeleteSelection,
  });

  const handleConnect = useCallback(
    (connection: Connection) => {
      if (!connection.source || !connection.target) {
        return;
      }
      const sourceNode = nodes.find((node) => node.id === connection.source);
      const targetNode = nodes.find((node) => node.id === connection.target);
      if (!sourceNode || !targetNode) {
        return;
      }
      if (!isValidConnection(sourceNode.data.kind, targetNode.data.kind)) {
        toast({
          title: t("action", "invalidConnection"),
          description: t("action", "invalidConnectionHint"),
          variant: "destructive",
        });
        return;
      }
      onConnect(connection);
      if (
        sourceNode.data.kind === ResourceType.Ingress &&
        targetNode.data.kind === ResourceType.Service
      ) {
        updateNode(sourceNode.id, {
          serviceName: targetNode.data.name,
          servicePort: targetNode.data.ports[0] ?? 80,
        });
      }
      if (
        sourceNode.data.kind === ResourceType.Service &&
        targetNode.data.kind !== ResourceType.Service
      ) {
        const selectors = sourceNode.data.selectors;
        if (
          Object.keys(selectors).length === 0 &&
          Object.keys(targetNode.data.labels).length > 0
        ) {
          updateNode(sourceNode.id, { selectors: targetNode.data.labels });
        }
      }
    },
    [nodes, onConnect, t, toast, updateNode]
  );

  const handleModeChange = useCallback(
    (value: string) => {
      if (value === "yaml") {
        syncToYaml();
        setMode("yaml");
        return;
      }
      if (value === "visual") {
        const result = syncFromYaml();
        if (!result.success) {
          toast({
            title: t("action", "invalidYaml"),
            description: result.message ?? t("action", "fixYamlBeforeCanvas"),
            variant: "destructive",
          });
          return;
        }
        setMode("visual");
      }
    },
    [syncFromYaml, syncToYaml, t, toast]
  );

  const buildApplyPayload = useCallback(
    (includeImportedResources: boolean) => {
      if (mode !== "visual") {
        return yamlText;
      }
      const scoped = includeImportedResources
        ? nodes
        : nodes.filter((node) => node.data.origin !== "cluster");
      return buildManifestYaml(
        scoped.map((node) => node.data),
        extraManifests
      );
    },
    [extraManifests, mode, nodes, yamlText]
  );

  const handleValidate = useCallback(async () => {
    const content = buildApplyPayload(includeImported);
    if (!content.trim()) {
      toast({
        title: t("empty", "nothingToValidate"),
        description: t("empty", "addResourcesFirst"),
        variant: "destructive",
      });
      return;
    }
    if (!isConnected) {
      toast({
        title: t("cluster", "notConnected"),
        description: t("cluster", "connectToValidate"),
        variant: "destructive",
      });
      return;
    }
    setIsValidating(true);
    try {
      const result = await commands.validateManifest(
        content,
        currentNamespace || null
      );
      const message =
        result.stderr || result.stdout || t("action", "validationCompleted");
      setLastResult({
        title: result.success
          ? t("action", "validationPassed")
          : t("action", "validationFailed"),
        message,
        success: result.success,
      });
      toast({
        title: result.success
          ? t("action", "validationPassed")
          : t("action", "validationFailed"),
        description: message,
        variant: result.success ? "default" : "destructive",
      });
    } catch (error) {
      const message = normalizeTauriError(error);
      setLastResult({
        title: t("action", "validationFailed"),
        message,
        success: false,
      });
      toast({
        title: t("action", "validationFailed"),
        description: message,
        variant: "destructive",
      });
    } finally {
      setIsValidating(false);
    }
  }, [
    buildApplyPayload,
    currentNamespace,
    includeImported,
    isConnected,
    t,
    toast,
  ]);

  const handleApply = useCallback(async () => {
    const content = buildApplyPayload(includeImported);
    if (!content.trim()) {
      toast({
        title: t("empty", "nothingToApply"),
        description: t("empty", "addResourcesFirst"),
        variant: "destructive",
      });
      return;
    }
    if (!isConnected) {
      toast({
        title: t("cluster", "notConnected"),
        description: t("cluster", "connectToApply"),
        variant: "destructive",
      });
      return;
    }
    setIsApplying(true);
    try {
      const result = await commands.applyManifest(
        content,
        currentNamespace || null
      );
      const message =
        result.stderr || result.stdout || t("action", "applyCompleted");
      setLastResult({
        title: result.success
          ? t("action", "applySucceeded")
          : t("action", "applyFailed"),
        message,
        success: result.success,
      });
      toast({
        title: result.success
          ? t("action", "applySucceeded")
          : t("action", "applyFailed"),
        description: message,
        variant: result.success ? "default" : "destructive",
      });
    } catch (error) {
      const message = normalizeTauriError(error);
      setLastResult({
        title: t("action", "applyFailed"),
        message,
        success: false,
      });
      toast({
        title: t("action", "applyFailed"),
        description: message,
        variant: "destructive",
      });
    } finally {
      setIsApplying(false);
    }
  }, [
    buildApplyPayload,
    currentNamespace,
    includeImported,
    isConnected,
    t,
    toast,
  ]);

  const { importFromCluster: handleImportFromCluster, isImporting } =
    useImportFromCluster(() => setMode("visual"));

  const handleTemplate = useCallback(
    (templateId: string) => {
      applyInfrastructureTemplate(templateId, {
        addResource,
        updateNode,
        onConnect,
        reactFlowInstance,
        namespace: currentNamespace || "default",
      });
    },
    [addResource, currentNamespace, onConnect, reactFlowInstance, updateNode]
  );

  const handleOpenYaml = useCallback(() => {
    syncToYaml();
    setMode("yaml");
  }, [syncToYaml]);

  const emptyCanvas = nodes.length === 0;

  return (
    <div className="flex flex-col gap-2 animate-in fade-in duration-200">
      <Tabs value={mode} onValueChange={handleModeChange}>
        <SectionHeader
          title={t("nav", "infrastructureBuilder")}
          count={t("count", "resources", { n: nodes.length })}
          actions={
            <>
              <TabsList>
                <TabsTrigger value="visual">{t("nav", "visual")}</TabsTrigger>
                <TabsTrigger value="yaml">YAML</TabsTrigger>
              </TabsList>
              <Button
                variant="ghost"
                size="sm"
                onClick={handleDeleteSelection}
                disabled={
                  selection.nodes.length === 0 && selection.edges.length === 0
                }
              >
                <Trash2 className="mr-1.5 h-3 w-3" aria-hidden="true" />
                {t("action", "deleteSelection")}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setClearOpen(true)}
              >
                {t("action", "clearCanvas")}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={handleImportFromCluster}
                disabled={isImporting}
              >
                {isImporting ? (
                  <Spinner size="sm" className="mr-1.5" />
                ) : (
                  <RefreshCw className="mr-1.5 h-3 w-3" aria-hidden="true" />
                )}
                {t("action", "import")}
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={handleValidate}
                disabled={isValidating}
              >
                {isValidating ? (
                  <Spinner size="sm" className="mr-1.5" />
                ) : (
                  <CheckCircle2 className="mr-1.5 h-3 w-3" aria-hidden="true" />
                )}
                {t("action", "validate")}
              </Button>
              <Button size="sm" onClick={handleApply} disabled={isApplying}>
                {isApplying ? (
                  <Spinner size="sm" className="mr-1.5" />
                ) : (
                  <Play className="mr-1.5 h-3 w-3" aria-hidden="true" />
                )}
                {t("action", "apply")}
              </Button>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={t("action", "openBuilderHelp")}
                    onClick={() => setHelpOpen(true)}
                  >
                    <HelpCircle className="h-3.5 w-3.5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent
                  side="bottom"
                  align="center"
                  className="max-w-xs"
                >
                  {t("action", "builderShortcutsTooltip")}
                </TooltipContent>
              </Tooltip>
            </>
          }
        />

        <div className="flex flex-wrap items-center gap-3 py-1">
          <Input
            placeholder={t("action", "filterResourcesPlaceholder")}
            aria-label={t("action", "filterResources")}
            className="w-56"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
          />
          {mode === "visual" && (
            <span className="flex items-center gap-1.5">
              <Switch
                id="include-imported"
                checked={includeImported}
                onCheckedChange={setIncludeImported}
              />
              <Label
                htmlFor="include-imported"
                className="text-[11px] font-normal text-fg-mut"
              >
                {t("action", "includeImported")}
              </Label>
            </span>
          )}
          {!isConnected && (
            <span className="flex items-center gap-1.5 text-[11px] text-warn">
              <AlertTriangle className="h-3 w-3" aria-hidden="true" />
              {t("cluster", "builderNotConnected")}
            </span>
          )}
        </div>

        <TabsContent value="visual">
          <div className="grid gap-3 lg:grid-cols-[220px_minmax(0,1fr)_300px]">
            <ResourcePalette
              onAdd={handlePaletteClick}
              onTemplate={handleTemplate}
              onPointerDown={handlePalettePointerDown}
            />
            <div className="flex min-h-[520px] flex-col gap-2">
              <div
                ref={reactFlowWrapper}
                className="relative h-[520px] flex-1 rounded border border-hair"
              >
                <ReactFlow
                  nodes={visibleNodes}
                  edges={edges}
                  nodeTypes={nodeTypes}
                  onNodesChange={onNodesChange}
                  onEdgesChange={onEdgesChange}
                  onConnect={handleConnect}
                  selectionOnDrag
                  selectionMode={SelectionMode.Partial}
                  onSelectionChange={handleSelectionChange}
                  onNodeClick={(_, node) => setSelectedNodeId(node.id)}
                  onPaneClick={() => setSelectedNodeId(null)}
                  onInit={setReactFlowInstance}
                  fitView
                  fitViewOptions={{ padding: 0.2 }}
                  className="rounded"
                >
                  <Background gap={16} size={1} color="hsl(var(--hair))" />
                  {/* React Flow ships its own light-mode chrome — white
                      buttons, a white minimap — which lands on the canvas as
                      two glowing rectangles. Its classes are overridden here
                      rather than in index.css so the override stays next to
                      the component that needs it. */}
                  <Controls className="[&>button]:border-hair [&>button]:bg-canvas [&>button]:fill-fg-mut [&>button:hover]:bg-hover" />
                  {/* The minimap answers "where am I in the graph", which is
                      a question about position. Six hues keyed to kind
                      answered a question nobody asked and put more colour on
                      screen than the rest of the app has in total. */}
                  <MiniMap
                    className="bg-canvas! rounded border border-hair"
                    nodeColor="hsl(var(--fg-fnt))"
                    maskColor="hsl(var(--canvas) / 0.6)"
                  />
                </ReactFlow>
                {emptyCanvas && (
                  <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
                    <p className="text-xs text-fg-mut">
                      {t("empty", "dragResourcesHere")}
                    </p>
                  </div>
                )}
              </div>
              <ResultNote result={lastResult} />
            </div>
            <InspectorPanel
              node={selectedNode}
              onUpdate={updateNode}
              onRemove={removeNode}
              onOpenYaml={handleOpenYaml}
            />
          </div>
        </TabsContent>

        <TabsContent value="yaml">
          <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_300px]">
            <div className="flex flex-col gap-2">
              <div className="overflow-hidden rounded border border-hair">
                <CodeMirror
                  value={yamlText}
                  height="520px"
                  theme={editorTheme}
                  extensions={[yamlLanguage()]}
                  onChange={(value) => setYamlText(value)}
                />
              </div>
              <ResultNote result={lastResult} />
            </div>
            <div className="flex flex-col gap-3 border-l border-hair pl-3">
              <p className="text-[11px] text-fg-mut">
                {t("action", "yamlPaneHint")}
              </p>
              {!isConnected && (
                <ConnectClusterEmptyState resourceLabel="Manifests" />
              )}
            </div>
          </div>
        </TabsContent>
      </Tabs>
      <ConfirmDialog
        open={clearOpen}
        onOpenChange={setClearOpen}
        title={t("action", "clearCanvasQuestion")}
        description={t("action", "clearCanvasConfirm")}
        confirmLabel={t("action", "clear")}
        confirmVariant="destructive"
        onConfirm={() => {
          setClearOpen(false);
          handleClearCanvas();
        }}
      />
      <Dialog open={helpOpen} onOpenChange={setHelpOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("action", "builderHelpTitle")}</DialogTitle>
            <DialogDescription>
              {t("action", "builderHelpHint")}
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-3 text-xs text-fg-mid">
            <div>
              <h3 className="pb-1 text-[11px] font-semibold uppercase tracking-[0.07em] text-fg-fnt">
                {t("action", "builderHelpCanvas")}
              </h3>
              <ul className="list-disc space-y-0.5 pl-4">
                <li>{t("action", "builderHelpDrag")}</li>
                <li>{t("action", "builderHelpClick")}</li>
                <li>{t("action", "builderHelpLasso")}</li>
                <li>{t("action", "builderHelpNode")}</li>
              </ul>
            </div>
            <div>
              <h3 className="pb-1 text-[11px] font-semibold uppercase tracking-[0.07em] text-fg-fnt">
                {t("action", "builderHelpShortcuts")}
              </h3>
              <ul className="list-disc space-y-0.5 pl-4">
                <li>{t("action", "builderHelpDelete")}</li>
                <li>{t("action", "builderHelpSelectAll")}</li>
                <li>{t("action", "builderHelpInvert")}</li>
              </ul>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/**
 * The outcome of the last Validate or Apply. It used to be a filled pastel
 * card, duplicated verbatim in both tabs; a kubectl transcript is text, so
 * it reads as text with a rule down its left edge in the outcome's colour.
 */
function ResultNote({
  result,
}: {
  result: { title: string; message: string; success: boolean } | null;
}) {
  if (!result) {
    return null;
  }
  return (
    <div
      className={cn(
        "border-l-2 py-1 pl-2.5 text-[11px]",
        result.success ? "border-ok" : "border-err"
      )}
    >
      <div
        className={cn("font-medium", result.success ? "text-ok" : "text-err")}
      >
        {result.title}
      </div>
      <pre className="mt-1 whitespace-pre-wrap font-mono text-fg-mut">
        {result.message}
      </pre>
    </div>
  );
}
