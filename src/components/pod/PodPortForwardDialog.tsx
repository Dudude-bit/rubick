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
import { PHASE_LABEL, podPorts } from "@/lib/container-sequence";
import type { PodInfo, PortForwardSessionInfo } from "@/generated/types";
import { useT } from "@/i18n/useT";

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
  const t = useT();
  // Sidecars included, app ports first. A mesh proxy's port is the one a
  // forward is usually aimed at, and it is not on `.containers` at all.
  const allPorts = podPorts(pod);
  // Only worth the ink once more than one container is offering ports —
  // otherwise every preset repeats the same name.
  const showOwner =
    new Set(allPorts.map((entry) => entry.container.name)).size > 1;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("action", "portForward")}</DialogTitle>
          <DialogDescription>
            {t("action", "portForwardHint")}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="rounded-md border p-3 text-sm">
            <div className="flex items-center justify-between">
              <span className="text-fg-mut">{t("columns", "target")}</span>
              <span className="font-medium">
                {pod.namespace}/{pod.name}
              </span>
            </div>
          </div>

          {allPorts.length > 0 && (
            <div className="space-y-2">
              <Label>{t("action", "quickPresets")}</Label>
              <div className="flex flex-wrap gap-2">
                {allPorts.map(({ container, port }) => (
                  <Button
                    key={`${container.name}-${port.containerPort}`}
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      setForm((prev) => ({
                        ...prev,
                        localPort: String(port.containerPort),
                        remotePort: String(port.containerPort),
                        name: port.name || `${pod.name}:${port.containerPort}`,
                      }))
                    }
                  >
                    {port.name
                      ? `${port.name} (${port.containerPort})`
                      : String(port.containerPort)}
                    <span className="ml-1 text-xs text-fg-mut">
                      {port.protocol}
                    </span>
                    {showOwner && (
                      <span className="ml-1.5 font-mono text-xs text-fg-fnt">
                        · {container.name}
                        {PHASE_LABEL[container.phase]
                          ? ` ${PHASE_LABEL[container.phase]}`
                          : ""}
                      </span>
                    )}
                  </Button>
                ))}
              </div>
              <p className="text-xs text-fg-mut">
                {t("action", "clickToAutofillPorts")}
              </p>
            </div>
          )}

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-2">
              <Label htmlFor="pf-local-port">{t("action", "localPort")}</Label>
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
              <Label htmlFor="pf-remote-port">
                {t("action", "remotePort")}
              </Label>
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
                <p className="text-sm font-medium">
                  {t("action", "autoReconnect")}
                </p>
                <p className="text-xs text-fg-mut">
                  {t("action", "autoReconnectHint")}
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
                <p className="text-sm font-medium">
                  {t("action", "saveAsConfig")}
                </p>
                <p className="text-xs text-fg-mut">
                  {t("action", "saveAsConfigHint")}
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
                    <p className="text-sm font-medium">
                      {t("action", "autoStart")}
                    </p>
                    <p className="text-xs text-fg-mut">
                      {t("action", "autoStartHint")}
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
                  <Label htmlFor="pf-config-name">
                    {t("action", "configName")}
                  </Label>
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
              <Label>{t("action", "activePortForwards")}</Label>
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
                        t("action", "activeInline")}
                    </div>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => onStopSession(session.id)}
                  >
                    {t("action", "stop")}
                  </Button>
                </div>
              ))}
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("action", "cancel")}
          </Button>
          <Button onClick={onSubmit} disabled={busy}>
            {busy ? t("action", "starting") : t("action", "startPortForward")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
