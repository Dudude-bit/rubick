/**
 * Port-forward dialog used from the Pod detail page.
 *
 * Extracted from `PodDetail.tsx` to keep that page focused on
 * orchestrating tabs / actions / data fetching. The dialog owns its
 * own form state and the start / stop / preset interactions; it
 * receives the pod + active session list + start/stop callbacks
 * from the caller.
 */

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
import type { PodInfo, PortForwardSessionInfo } from "@/generated/types";

export interface PortForwardFormState {
  name: string;
  localPort: string;
  remotePort: string;
  autoReconnect: boolean;
  autoStart: boolean;
  saveConfig: boolean;
}

interface PortForwardStatus {
  message?: string | null;
  status?: string | null;
}

export interface PodPortForwardDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  pod: PodInfo;
  form: PortForwardFormState;
  setForm: React.Dispatch<React.SetStateAction<PortForwardFormState>>;
  busy: boolean;
  onSubmit: () => void;
  /** Sessions filtered down to this pod (caller does the filtering). */
  activePortForwards: PortForwardSessionInfo[];
  /** Status map keyed by session id — used to render the live label. */
  portForwardStatusBySession: Record<string, PortForwardStatus | undefined>;
  onStopSession: (sessionId: string) => void;
}

export function PodPortForwardDialog({
  open,
  onOpenChange,
  pod,
  form,
  setForm,
  busy,
  onSubmit,
  activePortForwards,
  portForwardStatusBySession,
  onStopSession,
}: PodPortForwardDialogProps) {
  const allPorts = pod.containers.flatMap((container) =>
    container.ports.map((port) => ({
      containerName: container.name,
      port: port.containerPort,
      name: port.name,
      protocol: port.protocol,
    }))
  );

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
                {pod.namespace}/{pod.name}
              </span>
            </div>
          </div>

          {allPorts.length > 0 && (
            <div className="space-y-2">
              <Label>Quick presets</Label>
              <div className="flex flex-wrap gap-2">
                {allPorts.map((p) => (
                  <Button
                    key={`${p.containerName}-${p.port}`}
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      setForm((prev) => ({
                        ...prev,
                        localPort: String(p.port),
                        remotePort: String(p.port),
                        name: p.name || `${pod.name}:${p.port}`,
                      }))
                    }
                  >
                    {p.name ? `${p.name} (${p.port})` : String(p.port)}
                    <span className="ml-1 text-xs text-fg-mut">
                      {p.protocol}
                    </span>
                  </Button>
                ))}
              </div>
              <p className="text-xs text-fg-mut">
                Click to auto-fill local and remote ports
              </p>
            </div>
          )}

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
                onChange={(event) =>
                  setForm((prev) => ({
                    ...prev,
                    localPort: event.target.value,
                  }))
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
                onChange={(event) =>
                  setForm((prev) => ({
                    ...prev,
                    remotePort: event.target.value,
                  }))
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
                    onChange={(event) =>
                      setForm((prev) => ({ ...prev, name: event.target.value }))
                    }
                    placeholder={pod.name}
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
                      {portForwardStatusBySession[session.id]?.message ||
                        portForwardStatusBySession[session.id]?.status ||
                        "Active"}
                    </div>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => onStopSession(session.id)}
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
          <Button onClick={onSubmit} disabled={busy}>
            {busy ? "Starting..." : "Start port-forward"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
