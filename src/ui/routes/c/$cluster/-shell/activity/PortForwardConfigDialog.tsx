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
import {
  usePortForwardStore,
  type PortForwardConfig,
} from "@/stores/portForwardStore";
import { useT } from "@/i18n/useT";
import { toastWriteError } from "@/lib/toast-error";
import { parts } from "@/i18n/parts";

/**
 * The editor for a saved port-forward.
 *
 * `PortForwardDialog` starts a forward against the pod you are already
 * looking at, so its target is fixed. This one edits the stored config
 * itself, including which pod it points at, and is the only surface that can
 * rename or delete one.
 *
 * Mounted per invocation rather than kept behind an `open` flag, so the form
 * is seeded from props and never has to be washed out by an effect.
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
  const t = useT();
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
  const [checked, setChecked] = useState(false);

  const parsePort = (value: string): number | null => {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) return null;
    return parsed;
  };

  const local = parsePort(localPort);
  const remote = parsePort(remotePort);
  const missingTarget = !pod.trim() || !namespace.trim();
  const fieldError = "text-caption text-err";

  const save = async () => {
    setChecked(true);
    if (missingTarget || !local || !remote) return;

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
      toastWriteError(
        config
          ? t("activity", "saveForwardFailed")
          : t("activity", "createForwardFailed"),
        error
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {config
              ? t("activity", "editPortForward")
              : t("activity", "newPortForward")}
          </DialogTitle>
          <DialogDescription>
            {parts(t("activity", "forwardSavedFor"), {
              context: <span className="font-mono">{context}</span>,
            })}
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4">
          <div className="grid gap-2">
            <Label htmlFor="pfc-name">{t("columns", "name")}</Label>
            <Input
              id="pfc-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder={t("activity", "forwardNameExample")}
            />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-2">
              <Label htmlFor="pfc-pod">{t("columns", "pod")}</Label>
              <Input
                id="pfc-pod"
                value={pod}
                aria-invalid={checked && !pod.trim()}
                aria-describedby="pfc-target-note"
                onChange={(event) => setPod(event.target.value)}
                placeholder="my-pod-123"
                className="font-mono"
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="pfc-namespace">{t("columns", "namespace")}</Label>
              <Input
                id="pfc-namespace"
                value={namespace}
                aria-invalid={checked && !namespace.trim()}
                aria-describedby="pfc-target-note"
                onChange={(event) => setNamespace(event.target.value)}
                placeholder="default"
                className="font-mono"
              />
            </div>
          </div>
          {checked && missingTarget && (
            <p id="pfc-target-note" className={fieldError}>
              {t("activity", "missingTargetDetail")}
            </p>
          )}
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-2">
              <Label htmlFor="pfc-local">{t("activity", "localPort")}</Label>
              <Input
                id="pfc-local"
                type="number"
                inputMode="numeric"
                min={1}
                max={65535}
                value={localPort}
                aria-invalid={checked && !local}
                aria-describedby="pfc-port-note"
                onChange={(event) => setLocalPort(event.target.value)}
                placeholder="8080"
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="pfc-remote">{t("activity", "remotePort")}</Label>
              <Input
                id="pfc-remote"
                type="number"
                inputMode="numeric"
                min={1}
                max={65535}
                value={remotePort}
                aria-invalid={checked && !remote}
                aria-describedby="pfc-port-note"
                onChange={(event) => setRemotePort(event.target.value)}
                placeholder="80"
              />
            </div>
          </div>

          {checked && (!local || !remote) && (
            <p id="pfc-port-note" className={fieldError}>
              {t("activity", "invalidPortDetail")}
            </p>
          )}

          <div className="flex flex-col gap-4 border-t border-hair pt-4">
            <div className="flex items-center justify-between gap-4">
              <Label htmlFor="pfc-reconnect" className="font-normal">
                {t("activity", "autoReconnect")}
                <span className="mt-0.5 block text-caption text-fg-mut">
                  {t("activity", "autoReconnectHint")}
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
                {t("activity", "autoStartLabel")}
                <span className="mt-0.5 block text-caption text-fg-mut">
                  {t("activity", "autoStartHint")}
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
            {t("action", "cancel")}
          </Button>
          <Button onClick={save} pending={busy}>
            {config
              ? t("action", "saveChanges")
              : t("action", "savePortForward")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
