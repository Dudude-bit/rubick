import { useState } from "react";

import { Button } from "@/components/ui/button";
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
import { useToast } from "@/components/ui/use-toast";
import { normalizeTauriError } from "@/lib/error-utils";
import {
  usePortForwardStore,
  type PortForwardConfig,
} from "@/stores/portForwardStore";

/**
 * The editor for a saved port-forward.
 *
 * `PortForwardDialog` starts a forward against a pod you are already
 * looking at, so its target is fixed and its verb is "start". This one
 * edits the stored thing itself — including which pod it points at — and
 * is the only surface that can rename or delete one.
 *
 * It is mounted per invocation rather than kept around with an `open`
 * flag, so the form is seeded from props and never has to be washed out
 * by an effect on close.
 */
export function PortForwardConfigDialog({
  context,
  config,
  onClose,
}: {
  context: string;
  /** Omitted when creating. */
  config?: PortForwardConfig;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const addConfig = usePortForwardStore((state) => state.addConfig);
  const updateConfig = usePortForwardStore((state) => state.updateConfig);

  const [name, setName] = useState(config?.name ?? "");
  const [pod, setPod] = useState(config?.pod ?? "");
  const [namespace, setNamespace] = useState(config?.namespace ?? "");
  const [localPort, setLocalPort] = useState(
    config ? String(config.localPort) : ""
  );
  const [remotePort, setRemotePort] = useState(
    config ? String(config.remotePort) : ""
  );
  const [autoReconnect, setAutoReconnect] = useState(
    config?.autoReconnect ?? true
  );
  const [autoStart, setAutoStart] = useState(config?.autoStart ?? false);
  const [busy, setBusy] = useState(false);

  const parsePort = (value: string): number | null => {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) return null;
    return parsed;
  };

  const save = async () => {
    const local = parsePort(localPort);
    const remote = parsePort(remotePort);

    if (!pod.trim() || !namespace.trim()) {
      toast({
        title: "Missing target",
        description: "Pod name and namespace are required.",
        variant: "destructive",
      });
      return;
    }
    if (!local || !remote) {
      toast({
        title: "Invalid port",
        description: "Ports must be between 1 and 65535.",
        variant: "destructive",
      });
      return;
    }

    const fields = {
      name: name.trim() || `${pod.trim()}:${remote}`,
      pod: pod.trim(),
      namespace: namespace.trim(),
      localPort: local,
      remotePort: remote,
      autoReconnect,
      autoStart,
    };

    setBusy(true);
    try {
      if (config) {
        await updateConfig(config.id, fields);
      } else {
        await addConfig({ context, ...fields });
      }
      onClose();
    } catch (error) {
      toast({
        title: config
          ? "Failed to save port-forward"
          : "Failed to create port-forward",
        description: normalizeTauriError(error),
        variant: "destructive",
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {config ? "Edit port forward" : "New port forward"}
          </DialogTitle>
          <DialogDescription>
            Saved for <span className="font-mono">{context}</span> and offered
            in the activity panel until you delete it.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4">
          <div className="grid gap-2">
            <Label htmlFor="pfc-name">Name</Label>
            <Input
              id="pfc-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Auth API"
            />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-2">
              <Label htmlFor="pfc-pod">Pod</Label>
              <Input
                id="pfc-pod"
                value={pod}
                onChange={(event) => setPod(event.target.value)}
                placeholder="my-pod-123"
                className="font-mono"
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="pfc-namespace">Namespace</Label>
              <Input
                id="pfc-namespace"
                value={namespace}
                onChange={(event) => setNamespace(event.target.value)}
                placeholder="default"
                className="font-mono"
              />
            </div>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-2">
              <Label htmlFor="pfc-local">Local port</Label>
              <Input
                id="pfc-local"
                type="number"
                inputMode="numeric"
                min={1}
                max={65535}
                value={localPort}
                onChange={(event) => setLocalPort(event.target.value)}
                placeholder="8080"
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="pfc-remote">Remote port</Label>
              <Input
                id="pfc-remote"
                type="number"
                inputMode="numeric"
                min={1}
                max={65535}
                value={remotePort}
                onChange={(event) => setRemotePort(event.target.value)}
                placeholder="80"
              />
            </div>
          </div>

          <div className="flex flex-col gap-4 border-t border-hair pt-4">
            <div className="flex items-center justify-between gap-4">
              <Label htmlFor="pfc-reconnect" className="font-normal">
                Auto reconnect
                <span className="mt-0.5 block text-[11px] text-fg-mut">
                  Retry when the pod or the connection drops.
                </span>
              </Label>
              <Switch
                id="pfc-reconnect"
                checked={autoReconnect}
                onCheckedChange={setAutoReconnect}
              />
            </div>
            <div className="flex items-center justify-between gap-4">
              <Label htmlFor="pfc-autostart" className="font-normal">
                Auto start
                <span className="mt-0.5 block text-[11px] text-fg-mut">
                  Start as soon as this cluster connects.
                </span>
              </Label>
              <Switch
                id="pfc-autostart"
                checked={autoStart}
                onCheckedChange={setAutoStart}
              />
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={save} disabled={busy}>
            {config ? "Save changes" : "Save port forward"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
