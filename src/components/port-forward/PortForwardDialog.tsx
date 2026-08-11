import { useState, useEffect } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/components/ui/use-toast";
import { commands } from "@/lib/commands";
import { usePortForwardStore } from "@/stores/portForwardStore";
import { useClusterStore } from "@/stores/clusterStore";

interface PortForwardFormState {
  localPort: string;
  remotePort: string;
  autoReconnect: boolean;
  saveConfig: boolean;
  autoStart: boolean;
  name: string;
}

export interface PortForwardDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  podName: string;
  podNamespace: string;
  /** Pre-fill with this port */
  initialPort?: number;
  /** Optional port name for config name */
  portName?: string;
}

export function PortForwardDialog({
  open,
  onOpenChange,
  podName,
  podNamespace,
  initialPort,
  portName,
}: PortForwardDialogProps) {
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);
  const sessions = usePortForwardStore((state) => state.sessions);
  const statusBySession = usePortForwardStore((state) => state.statusBySession);
  const currentContext = useClusterStore((state) => state.currentContext);

  const [form, setForm] = useState<PortForwardFormState>({
    localPort: "",
    remotePort: "",
    autoReconnect: true,
    saveConfig: false,
    autoStart: false,
    name: "",
  });

  // Pre-fill form when dialog opens with initialPort. Genuine
  // sync-prop-into-state: caller's `initialPort` is the seed for an
  // edit-in-progress form. A `key`-style remount via parent would
  // be cleaner but every callsite currently controls the dialog's
  // `open` state by hand.
  useEffect(() => {
    if (open && initialPort) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setForm((prev) => ({
        ...prev,
        localPort: String(initialPort),
        remotePort: String(initialPort),
        name: portName || `${podName}:${initialPort}`,
      }));
    }
  }, [open, initialPort, portName, podName]);

  // Reset form when dialog closes. Same justification as above —
  // close transitions in this dialog are a stable place to wipe the
  // form. Cleanest fix is a future `key={open ? id : "closed"}`
  // refactor at every callsite.
  useEffect(() => {
    if (!open) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setForm({
        localPort: "",
        remotePort: "",
        autoReconnect: true,
        saveConfig: false,
        autoStart: false,
        name: "",
      });
    }
  }, [open]);

  const activePortForwards = sessions.filter(
    (s) => s.pod === podName && s.namespace === podNamespace
  );

  const parsePortValue = (value: string): number | null => {
    const parsed = parseInt(value, 10);
    if (isNaN(parsed) || parsed < 1 || parsed > 65535) return null;
    return parsed;
  };

  const handlePortForward = async () => {
    const localPort = parsePortValue(form.localPort);
    const remotePort = parsePortValue(form.remotePort);

    if (!localPort || !remotePort) {
      toast({
        title: "Invalid port",
        description: "Please enter valid port numbers (1-65535)",
        variant: "destructive",
      });
      return;
    }

    setBusy(true);
    try {
      if (form.saveConfig && currentContext) {
        await commands.createPortForwardConfig({
          context: currentContext,
          name: form.name.trim() || `${podName}:${remotePort}`,
          pod: podName,
          namespace: podNamespace,
          localPort,
          remotePort,
          autoReconnect: form.autoReconnect,
          autoStart: form.autoStart,
        });
      } else {
        await commands.portForwardPod(podName, podNamespace, {
          localPort,
          remotePort,
          autoReconnect: form.autoReconnect,
        });
      }
      toast({
        title: "Port forward started",
        description: `Forwarding localhost:${localPort} → ${podName}:${remotePort}`,
      });
      onOpenChange(false);
    } catch (error) {
      toast({
        title: "Failed to start port forward",
        description: String(error),
        variant: "destructive",
      });
    } finally {
      setBusy(false);
    }
  };

  const handleStopPortForward = async (sessionId: string) => {
    try {
      await commands.stopPortForward(sessionId);
      toast({
        title: "Port forward stopped",
      });
    } catch (error) {
      toast({
        title: "Failed to stop port forward",
        description: String(error),
        variant: "destructive",
      });
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Port forward</DialogTitle>
          <DialogDescription>
            Forward traffic from your machine to this pod.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="rounded-md border p-3 text-sm">
            <div className="flex items-center justify-between">
              <span className="text-fg-mut">Target</span>
              <span className="font-medium">
                {podNamespace}/{podName}
              </span>
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-2">
              <Label htmlFor="pf-local-port">Local port</Label>
              <Input
                id="pf-local-port"
                type="number"
                inputMode="numeric"
                min={1}
                max={65535}
                value={form.localPort}
                onChange={(e) =>
                  setForm((prev) => ({ ...prev, localPort: e.target.value }))
                }
                placeholder="8080"
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="pf-remote-port">Remote port</Label>
              <Input
                id="pf-remote-port"
                type="number"
                inputMode="numeric"
                min={1}
                max={65535}
                value={form.remotePort}
                onChange={(e) =>
                  setForm((prev) => ({ ...prev, remotePort: e.target.value }))
                }
                placeholder="80"
              />
            </div>
          </div>

          <div className="rounded-md border p-3 space-y-3">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium">Auto reconnect</p>
                <p className="text-xs text-fg-mut">
                  Retry when the pod or connection drops
                </p>
              </div>
              <Switch
                checked={form.autoReconnect}
                onCheckedChange={(checked) =>
                  setForm((prev) => ({ ...prev, autoReconnect: checked }))
                }
              />
            </div>
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium">Save as config</p>
                <p className="text-xs text-fg-mut">
                  Keep this port-forward for quick reuse
                </p>
              </div>
              <Switch
                checked={form.saveConfig}
                onCheckedChange={(checked) =>
                  setForm((prev) => ({ ...prev, saveConfig: checked }))
                }
              />
            </div>
            {form.saveConfig && (
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm font-medium">Auto start</p>
                    <p className="text-xs text-fg-mut">
                      Start automatically when this cluster connects
                    </p>
                  </div>
                  <Switch
                    checked={form.autoStart}
                    onCheckedChange={(checked) =>
                      setForm((prev) => ({ ...prev, autoStart: checked }))
                    }
                  />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="pf-config-name">Config name</Label>
                  <Input
                    id="pf-config-name"
                    value={form.name}
                    onChange={(e) =>
                      setForm((prev) => ({ ...prev, name: e.target.value }))
                    }
                    placeholder={podName}
                  />
                </div>
              </div>
            )}
          </div>

          {activePortForwards.length > 0 && (
            <div className="space-y-2">
              <Label>Active port-forwards</Label>
              {activePortForwards.map((session) => (
                <div
                  key={session.id}
                  className="flex flex-wrap items-center justify-between gap-3 rounded-md border p-3 text-sm"
                >
                  <div>
                    <div className="font-medium">
                      {session.localPort} → {session.pod}:{session.remotePort}
                    </div>
                    <div className="text-xs text-fg-mut">
                      {statusBySession[session.id]?.message ||
                        statusBySession[session.id]?.status ||
                        "Active"}
                    </div>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => handleStopPortForward(session.id)}
                  >
                    Stop
                  </Button>
                </div>
              ))}
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handlePortForward} disabled={busy}>
            {busy ? "Starting..." : "Start port-forward"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
