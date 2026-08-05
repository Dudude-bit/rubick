import { useEffect, useMemo, useState } from "react";
import { useClusterStore } from "@/stores/clusterStore";
import {
  PortForwardConfig,
  PortForwardSession,
  usePortForwardStore,
} from "@/stores/portForwardStore";
import { useToast } from "@/components/ui/use-toast";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { RefreshButton } from "@/components/ui/refresh-button";
import { Section, SectionHeader } from "@/components/ui/section";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Pencil, Play, Plus, Square, Trash2 } from "lucide-react";
import { normalizeTauriError } from "@/lib/error-utils";

type PortForwardFormState = {
  name: string;
  pod: string;
  namespace: string;
  localPort: string;
  remotePort: string;
  autoReconnect: boolean;
  autoStart: boolean;
};

const emptyFormState: PortForwardFormState = {
  name: "",
  pod: "",
  namespace: "",
  localPort: "",
  remotePort: "",
  autoReconnect: true,
  autoStart: false,
};

const portStatusBadge = (status?: string) => {
  if (!status) {
    return null;
  }
  const normalized = status.toLowerCase();
  if (normalized === "listening") {
    return { label: "Listening", variant: "success" as const };
  }
  if (normalized === "reconnecting") {
    return { label: "Reconnecting", variant: "warning" as const };
  }
  if (normalized === "reconnected") {
    return { label: "Reconnected", variant: "success" as const };
  }
  if (normalized === "error") {
    return { label: "Error", variant: "destructive" as const };
  }
  return { label: status, variant: "secondary" as const };
};

const parsePort = (value: string): number | null => {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) {
    return null;
  }
  return parsed;
};

const sessionKey = (item: {
  context: string;
  pod: string;
  namespace: string;
  localPort: number;
  remotePort: number;
}) =>
  `${item.context}:${item.namespace}:${item.pod}:${item.localPort}:${item.remotePort}`;

export function PortForwardManager() {
  const { toast } = useToast();
  const currentContext = useClusterStore((state) => state.currentContext);
  const configs = usePortForwardStore((state) => state.configs);
  const sessions = usePortForwardStore((state) => state.sessions);
  const statusBySession = usePortForwardStore((state) => state.statusBySession);
  const addConfig = usePortForwardStore((state) => state.addConfig);
  const updateConfig = usePortForwardStore((state) => state.updateConfig);
  const removeConfig = usePortForwardStore((state) => state.removeConfig);
  const startConfig = usePortForwardStore((state) => state.startConfig);
  const stopSession = usePortForwardStore((state) => state.stopSession);
  const refreshConfigs = usePortForwardStore((state) => state.refreshConfigs);
  const refreshSessions = usePortForwardStore((state) => state.refreshSessions);
  const startAllForContext = usePortForwardStore(
    (state) => state.startAllForContext
  );

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingConfig, setEditingConfig] = useState<PortForwardConfig | null>(
    null
  );
  const [formState, setFormState] =
    useState<PortForwardFormState>(emptyFormState);
  const [startAllBusy, setStartAllBusy] = useState(false);
  const [actionConfigId, setActionConfigId] = useState<string | null>(null);

  useEffect(() => {
    refreshSessions().catch((error) => {
      console.error("Failed to refresh port-forward sessions:", error);
    });
  }, [refreshSessions, currentContext]);

  useEffect(() => {
    refreshConfigs().catch((error) => {
      console.error("Failed to refresh port-forward configs:", error);
    });
  }, [refreshConfigs]);

  const contextConfigs = useMemo(
    () => configs.filter((config) => config.context === currentContext),
    [configs, currentContext]
  );

  const contextSessions = useMemo(
    () => sessions.filter((session) => session.context === currentContext),
    [sessions, currentContext]
  );

  const sessionsByKey = useMemo(() => {
    const map = new Map<string, PortForwardSession>();
    for (const session of contextSessions) {
      map.set(sessionKey(session), session);
    }
    return map;
  }, [contextSessions]);

  const unmanagedSessions = useMemo(() => {
    const configKeys = new Set(
      contextConfigs.map((config) => sessionKey(config))
    );
    return contextSessions.filter(
      (session) => !configKeys.has(sessionKey(session))
    );
  }, [contextConfigs, contextSessions]);

  const openCreateDialog = () => {
    setEditingConfig(null);
    setFormState(emptyFormState);
    setDialogOpen(true);
  };

  const openEditDialog = (config: PortForwardConfig) => {
    setEditingConfig(config);
    setFormState({
      name: config.name,
      pod: config.pod,
      namespace: config.namespace,
      localPort: String(config.localPort),
      remotePort: String(config.remotePort),
      autoReconnect: config.autoReconnect,
      autoStart: config.autoStart,
    });
    setDialogOpen(true);
  };

  const handleSaveConfig = async () => {
    if (!currentContext) {
      toast({
        title: "No cluster selected",
        description: "Connect to a cluster to create port-forward configs.",
        variant: "destructive",
      });
      return;
    }

    const localPort = parsePort(formState.localPort);
    const remotePort = parsePort(formState.remotePort);

    if (!formState.pod.trim() || !formState.namespace.trim()) {
      toast({
        title: "Missing target",
        description: "Pod name and namespace are required.",
        variant: "destructive",
      });
      return;
    }

    if (!localPort || !remotePort) {
      toast({
        title: "Invalid port",
        description: "Ports must be between 1 and 65535.",
        variant: "destructive",
      });
      return;
    }

    const name = formState.name.trim() || `${formState.pod}:${remotePort}`;

    try {
      if (editingConfig) {
        await updateConfig(editingConfig.id, {
          name,
          pod: formState.pod.trim(),
          namespace: formState.namespace.trim(),
          localPort,
          remotePort,
          autoReconnect: formState.autoReconnect,
          autoStart: formState.autoStart,
        });
        setDialogOpen(false);
        return;
      }

      await addConfig({
        context: currentContext,
        name,
        pod: formState.pod.trim(),
        namespace: formState.namespace.trim(),
        localPort,
        remotePort,
        autoReconnect: formState.autoReconnect,
        autoStart: formState.autoStart,
      });
      setDialogOpen(false);
    } catch (error) {
      toast({
        title: "Failed to save port-forward config",
        description: normalizeTauriError(error),
        variant: "destructive",
      });
    }
  };

  const handleStartConfig = async (configId: string) => {
    setActionConfigId(configId);
    try {
      await startConfig(configId);
    } catch (error) {
      toast({
        title: "Failed to start port-forward",
        description: normalizeTauriError(error),
        variant: "destructive",
      });
    } finally {
      setActionConfigId(null);
    }
  };

  const handleStopSession = async (sessionId: string) => {
    setActionConfigId(sessionId);
    try {
      await stopSession(sessionId);
    } catch (error) {
      toast({
        title: "Failed to stop port-forward",
        description: normalizeTauriError(error),
        variant: "destructive",
      });
    } finally {
      setActionConfigId(null);
    }
  };

  const handleRemoveConfig = async (configId: string) => {
    setActionConfigId(configId);
    try {
      await removeConfig(configId);
    } catch (error) {
      toast({
        title: "Failed to remove port-forward config",
        description: normalizeTauriError(error),
        variant: "destructive",
      });
    } finally {
      setActionConfigId(null);
    }
  };

  const handleStartAll = async () => {
    if (!currentContext) {
      toast({
        title: "No cluster selected",
        description: "Connect to a cluster to start port-forwards.",
        variant: "destructive",
      });
      return;
    }

    setStartAllBusy(true);
    try {
      const result = await startAllForContext(currentContext);
      toast({
        title: "Port-forward batch complete",
        description: `Started ${result.started}, skipped ${result.skipped}, failed ${result.failed}.`,
      });
    } catch (error) {
      toast({
        title: "Failed to start all port-forwards",
        description: normalizeTauriError(error),
        variant: "destructive",
      });
    } finally {
      setStartAllBusy(false);
    }
  };

  const handleToggleAutoReconnect = async (
    config: PortForwardConfig,
    checked: boolean
  ) => {
    try {
      await updateConfig(config.id, { autoReconnect: checked });
      const activeSession = sessionsByKey.get(sessionKey(config));
      if (activeSession) {
        toast({
          title: "Auto-reconnect updated",
          description:
            "Changes will apply the next time this port-forward starts.",
        });
      }
    } catch (error) {
      toast({
        title: "Failed to update auto-reconnect",
        description: normalizeTauriError(error),
        variant: "destructive",
      });
    }
  };

  const handleToggleAutoStart = async (
    config: PortForwardConfig,
    checked: boolean
  ) => {
    try {
      await updateConfig(config.id, { autoStart: checked });
    } catch (error) {
      toast({
        title: "Failed to update auto-start",
        description: normalizeTauriError(error),
        variant: "destructive",
      });
    }
  };

  return (
    <Section>
      <SectionHeader
        title="Port Forwards"
        description="Save and run per-cluster port-forward configurations"
      />
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-sm">
            <span className="text-muted-foreground">Cluster</span>
            <Badge variant={currentContext ? "outline" : "destructive"}>
              {currentContext || "Not connected"}
            </Badge>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <RefreshButton
              onRefresh={() => {
                refreshSessions().catch((error) => {
                  console.error(
                    "Failed to refresh port-forward sessions:",
                    error
                  );
                });
                refreshConfigs().catch((error) => {
                  console.error(
                    "Failed to refresh port-forward configs:",
                    error
                  );
                });
              }}
              variant="outline"
              size="sm"
            >
              Refresh
            </RefreshButton>
            <Button
              variant="outline"
              size="sm"
              onClick={handleStartAll}
              disabled={
                startAllBusy || !currentContext || contextConfigs.length === 0
              }
            >
              <Play className="mr-2 h-4 w-4" />
              {startAllBusy ? "Starting..." : "Start All"}
            </Button>
            <Button
              size="sm"
              onClick={openCreateDialog}
              disabled={!currentContext}
            >
              <Plus className="mr-2 h-4 w-4" />
              New Config
            </Button>
          </div>
        </div>

        {contextConfigs.length === 0 ? (
          <div className="rounded-md border border-dashed p-6 text-sm text-muted-foreground">
            {currentContext
              ? "No port-forward configs for this cluster yet."
              : "Connect to a cluster to create port-forward configs."}
          </div>
        ) : (
          <div className="space-y-3">
            {contextConfigs.map((config) => {
              const activeSession = sessionsByKey.get(sessionKey(config));
              const statusInfo = activeSession
                ? portStatusBadge(statusBySession[activeSession.id]?.status)
                : null;
              return (
                <div
                  key={config.id}
                  className="rounded-lg border p-4 text-sm space-y-3"
                >
                  <div className="flex flex-wrap items-start justify-between gap-4">
                    <div className="space-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium">{config.name}</span>
                        <Badge
                          variant={activeSession ? "success" : "secondary"}
                        >
                          {activeSession ? "Active" : "Idle"}
                        </Badge>
                        {statusInfo && (
                          <Badge variant={statusInfo.variant}>
                            {statusInfo.label}
                          </Badge>
                        )}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {config.namespace}/{config.pod} · {config.localPort} →
                        {config.pod}:{config.remotePort}
                      </div>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      {activeSession ? (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => handleStopSession(activeSession.id)}
                          disabled={actionConfigId === activeSession.id}
                        >
                          <Square className="mr-2 h-4 w-4" />
                          Stop
                        </Button>
                      ) : (
                        <Button
                          size="sm"
                          onClick={() => handleStartConfig(config.id)}
                          disabled={actionConfigId === config.id}
                        >
                          <Play className="mr-2 h-4 w-4" />
                          Start
                        </Button>
                      )}
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => openEditDialog(config)}
                      >
                        <Pencil className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => handleRemoveConfig(config.id)}
                        disabled={actionConfigId === config.id}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="flex flex-wrap items-center gap-4">
                      <div className="flex items-center gap-2">
                        <Switch
                          checked={config.autoReconnect}
                          onCheckedChange={(checked) =>
                            handleToggleAutoReconnect(config, checked)
                          }
                        />
                        <Label className="text-sm">Auto reconnect</Label>
                      </div>
                      <div className="flex items-center gap-2">
                        <Switch
                          checked={config.autoStart}
                          onCheckedChange={(checked) =>
                            handleToggleAutoStart(config, checked)
                          }
                        />
                        <Label className="text-sm">Auto start</Label>
                      </div>
                    </div>
                    {activeSession &&
                    statusBySession[activeSession.id]?.message ? (
                      <span className="text-xs text-muted-foreground">
                        {statusBySession[activeSession.id]?.message}
                      </span>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {unmanagedSessions.length > 0 && (
          <div className="space-y-2">
            <div className="text-sm font-medium">Active sessions</div>
            <div className="space-y-2">
              {unmanagedSessions.map((session) => {
                const statusInfo = portStatusBadge(
                  statusBySession[session.id]?.status
                );
                return (
                  <div
                    key={session.id}
                    className="flex flex-wrap items-center justify-between gap-3 rounded-md border p-3 text-sm"
                  >
                    <div className="space-y-1">
                      <div className="flex items-center gap-2">
                        <span className="font-medium">
                          {session.localPort} → {session.pod}:
                          {session.remotePort}
                        </span>
                        {statusInfo && (
                          <Badge variant={statusInfo.variant}>
                            {statusInfo.label}
                          </Badge>
                        )}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {session.namespace}/{session.pod}
                      </div>
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => handleStopSession(session.id)}
                      disabled={actionConfigId === session.id}
                    >
                      <Square className="mr-2 h-4 w-4" />
                      Stop
                    </Button>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {editingConfig ? "Edit port-forward" : "New port-forward"}
            </DialogTitle>
            <DialogDescription>
              {editingConfig
                ? "Update the saved port-forward configuration."
                : "Save a reusable port-forward configuration for this cluster."}
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4">
            <div className="grid gap-2">
              <Label htmlFor="pf-name">Name</Label>
              <Input
                id="pf-name"
                value={formState.name}
                onChange={(event) =>
                  setFormState((prev) => ({
                    ...prev,
                    name: event.target.value,
                  }))
                }
                placeholder="Auth API"
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="pf-pod">Pod</Label>
              <Input
                id="pf-pod"
                value={formState.pod}
                onChange={(event) =>
                  setFormState((prev) => ({ ...prev, pod: event.target.value }))
                }
                placeholder="my-pod-123"
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="pf-namespace">Namespace</Label>
              <Input
                id="pf-namespace"
                value={formState.namespace}
                onChange={(event) =>
                  setFormState((prev) => ({
                    ...prev,
                    namespace: event.target.value,
                  }))
                }
                placeholder="default"
              />
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="grid gap-2">
                <Label htmlFor="pf-local">Local port</Label>
                <Input
                  id="pf-local"
                  type="number"
                  inputMode="numeric"
                  min={1}
                  max={65535}
                  value={formState.localPort}
                  onChange={(event) =>
                    setFormState((prev) => ({
                      ...prev,
                      localPort: event.target.value,
                    }))
                  }
                  placeholder="8080"
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="pf-remote">Remote port</Label>
                <Input
                  id="pf-remote"
                  type="number"
                  inputMode="numeric"
                  min={1}
                  max={65535}
                  value={formState.remotePort}
                  onChange={(event) =>
                    setFormState((prev) => ({
                      ...prev,
                      remotePort: event.target.value,
                    }))
                  }
                  placeholder="80"
                />
              </div>
            </div>
            <div className="flex items-center justify-between rounded-md border p-3">
              <div>
                <p className="text-sm font-medium">Auto reconnect</p>
                <p className="text-xs text-muted-foreground">
                  Retry when the pod or connection drops
                </p>
              </div>
              <Switch
                checked={formState.autoReconnect}
                onCheckedChange={(checked) =>
                  setFormState((prev) => ({ ...prev, autoReconnect: checked }))
                }
              />
            </div>
            <div className="flex items-center justify-between rounded-md border p-3">
              <div>
                <p className="text-sm font-medium">Auto start</p>
                <p className="text-xs text-muted-foreground">
                  Start automatically when this cluster connects
                </p>
              </div>
              <Switch
                checked={formState.autoStart}
                onCheckedChange={(checked) =>
                  setFormState((prev) => ({ ...prev, autoStart: checked }))
                }
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleSaveConfig}>
              {editingConfig ? "Save changes" : "Save config"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Section>
  );
}
