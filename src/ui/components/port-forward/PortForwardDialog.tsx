import { useState } from "react";
import { AlertTriangle, ArrowRight, Square } from "lucide-react";

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
import { ResourceName } from "@/components/object/ResourceName";
import { usePortForwardStore } from "@/stores/portForwardStore";
import { useClusterStore } from "@/stores/clusterStore";
import { useT } from "@/i18n/useT";
import { parts } from "@/i18n/parts";
import { toastError } from "@/lib/toast-error";
import { ERROR_CODES, errorCode } from "@/lib/error-utils";
import { cn } from "@/lib/utils";
import { usePodDenied } from "@/lib/access";
import { ReasonTip } from "@/components/object/detail-blocks";
import {
  forwardNoteWords,
  localPortProblem,
  suggestedLocalPort,
  type ForwardPort,
  type LocalPortProblem,
} from "@/lib/port-forward";

/** What a forward is aimed at. A Service is followed to a ready pod by the backend. */
export interface ForwardTarget {
  kind: "Pod" | "Service";
  name: string;
  namespace: string;
  ports: ForwardPort[];
}

export interface PortForwardDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  target: ForwardTarget;
  /** The port to fill in; the target's first port when absent. */
  initialPort?: number;
}

/**
 * The one port-forward dialog, for a pod and for a Service alike.
 *
 * The local port is filled in with a number a normal user may listen on and
 * the address it will open at is shown before starting: a container on 80
 * used to seed local 80, which fails without root.
 */
export function PortForwardDialog({
  open,
  onOpenChange,
  target,
  initialPort,
}: PortForwardDialogProps) {
  const t = useT();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("action", "portForward")}</DialogTitle>
          <DialogDescription>
            {target.kind === "Service"
              ? t("activity", "forwardDialogServiceHint")
              : t("activity", "forwardDialogHint")}
          </DialogDescription>
        </DialogHeader>
        <ForwardForm
          target={target}
          initialPort={initialPort}
          onDone={() => onOpenChange(false)}
        />
      </DialogContent>
    </Dialog>
  );
}

function parsePort(value: string): number | null {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 65535
    ? parsed
    : null;
}

/** Mounted on every open, so the form is seeded from props and never washed. */
function ForwardForm({
  target,
  initialPort,
  onDone,
}: {
  target: ForwardTarget;
  initialPort?: number;
  onDone: () => void;
}) {
  const t = useT();
  const sessions = usePortForwardStore((state) => state.sessions);
  const statusBySession = usePortForwardStore((state) => state.statusBySession);
  const startPod = usePortForwardStore((state) => state.startPod);
  const startService = usePortForwardStore((state) => state.startService);
  const addConfig = usePortForwardStore((state) => state.addConfig);
  const stopSession = usePortForwardStore((state) => state.stopSession);
  const currentContext = useClusterStore((state) => state.currentContext);
  const denied = usePodDenied(target.namespace).portForward;

  const taken = new Set(sessions.map((session) => session.localPort));
  const firstPort = initialPort ?? target.ports[0]?.port;

  const [remote, setRemote] = useState(
    firstPort !== undefined ? String(firstPort) : ""
  );
  const [local, setLocal] = useState(
    firstPort !== undefined ? String(suggestedLocalPort(firstPort, taken)) : ""
  );
  const [autoReconnect, setAutoReconnect] = useState(true);
  const [saveConfig, setSaveConfig] = useState(false);
  const [autoStart, setAutoStart] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<LocalPortProblem | null>(null);
  const [noPod, setNoPod] = useState(false);
  const [checked, setChecked] = useState(false);

  const remotePort = parsePort(remote);
  const localPort = local.trim() === "" ? 0 : parsePort(local);
  const canSave = target.kind === "Pod";
  const localMissingForSave = saveConfig && localPort === 0;

  const pick = (port: number) => {
    setRemote(String(port));
    setLocal(String(suggestedLocalPort(port, taken)));
    setProblem(null);
    setNoPod(false);
  };

  const active = sessions.filter((session) =>
    target.kind === "Pod"
      ? session.pod === target.name && session.namespace === target.namespace
      : session.via.kind === "service" &&
        session.via.name === target.name &&
        session.namespace === target.namespace
  );

  const submit = async () => {
    setChecked(true);
    if (remotePort === null || localPort === null || localMissingForSave)
      return;
    setBusy(true);
    setProblem(null);
    setNoPod(false);
    const request = { localPort, remotePort, autoReconnect };
    try {
      const session =
        target.kind === "Service"
          ? await startService(target.name, target.namespace, request)
          : await startPod(target.name, target.namespace, request);
      if (saveConfig && currentContext) {
        await addConfig({
          context: currentContext,
          name: name.trim() || `${target.name}:${remotePort}`,
          pod: target.name,
          namespace: target.namespace,
          localPort: session.localPort,
          remotePort,
          autoReconnect,
          autoStart,
        }).catch((error) =>
          toastError(t("activity", "saveForwardFailed"), error)
        );
      }
      onDone();
    } catch (error) {
      const local = localPortProblem(error, localPort, taken, t);
      if (local) setProblem(local);
      else if (errorCode(error) === ERROR_CODES.NO_READY_POD) setNoPod(true);
      else toastError(t("activity", "startForwardFailed"), error);
    } finally {
      setBusy(false);
    }
  };

  const fieldError = "text-[11px] text-err";

  return (
    <>
      <div className="space-y-4">
        <div className="flex items-center justify-between gap-3 rounded-md border border-hair p-3 text-sm">
          <span className="text-fg-mut">{t("columns", "target")}</span>
          <span className="min-w-0 truncate">
            <span className="text-fg-fnt">{target.namespace}/</span>
            <ResourceName kind={target.kind} name={target.name} />
          </span>
        </div>

        {target.ports.length > 1 && (
          <div className="flex flex-wrap gap-2">
            {target.ports.map((port) => (
              <Button
                key={`${port.owner ?? ""}-${port.port}`}
                type="button"
                variant="outline"
                size="sm"
                aria-pressed={remotePort === port.port}
                className={cn(remotePort === port.port && "border-info")}
                onClick={() => pick(port.port)}
              >
                {port.name ? `${port.name} (${port.port})` : String(port.port)}
                <span className="ml-1 text-xs text-fg-mut">
                  {port.protocol}
                </span>
                {port.owner && (
                  <span className="ml-1.5 font-mono text-xs text-fg-fnt">
                    · {port.owner}
                  </span>
                )}
              </Button>
            ))}
          </div>
        )}

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="grid content-start gap-1.5">
            <Label htmlFor="pf-remote-port">
              {target.kind === "Service"
                ? t("activity", "servicePort")
                : t("activity", "podPort")}
            </Label>
            <Input
              id="pf-remote-port"
              type="number"
              inputMode="numeric"
              min={1}
              max={65535}
              value={remote}
              aria-invalid={checked && remotePort === null}
              aria-describedby="pf-remote-port-note"
              onChange={(event) => {
                setRemote(event.target.value);
                setNoPod(false);
              }}
            />
            {checked && remotePort === null && (
              <p id="pf-remote-port-note" className={fieldError}>
                {t("activity", "remotePortInvalid")}
              </p>
            )}
          </div>
          <div className="grid content-start gap-1.5">
            <Label htmlFor="pf-local-port">{t("activity", "localPort")}</Label>
            <Input
              id="pf-local-port"
              type="number"
              inputMode="numeric"
              min={1}
              max={65535}
              value={local}
              aria-invalid={
                (checked && (localPort === null || localMissingForSave)) ||
                problem !== null
              }
              aria-describedby="pf-local-port-note"
              onChange={(event) => {
                setLocal(event.target.value);
                setProblem(null);
              }}
            />
            <p
              id="pf-local-port-note"
              className={
                checked && (localPort === null || localMissingForSave)
                  ? fieldError
                  : "text-[11px] text-fg-fnt"
              }
            >
              {checked && localPort === null
                ? t("activity", "localPortInvalid")
                : checked && localMissingForSave
                  ? t("activity", "savedNeedsLocalPort")
                  : t("activity", "localPortEmptyHint")}
            </p>
          </div>
        </div>

        {problem ? (
          <div
            role="alert"
            className="flex items-start gap-2 border-l-2 border-err py-1.5 pl-2.5 text-xs text-err"
          >
            <AlertTriangle
              className="mt-0.5 h-3.5 w-3.5 flex-none"
              aria-hidden="true"
            />
            <div className="min-w-0 space-y-1.5">
              <p>{problem.says}</p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => {
                  setLocal(String(problem.suggestion));
                  setProblem(null);
                }}
              >
                {t("activity", "useSuggestedPort", {
                  port: problem.suggestion,
                })}
              </Button>
            </div>
          </div>
        ) : noPod ? (
          <div
            role="alert"
            className="flex items-start gap-2 border-l-2 border-err py-1.5 pl-2.5 text-xs text-err"
          >
            <AlertTriangle
              className="mt-0.5 h-3.5 w-3.5 flex-none"
              aria-hidden="true"
            />
            <p>{t("empty", "gwNoReadyPodBehind", { name: target.name })}</p>
          </div>
        ) : (
          localPort !== null &&
          remotePort !== null && (
            <p className="flex items-center gap-1.5 text-xs text-fg-mut">
              <ArrowRight
                className="h-3.5 w-3.5 flex-none text-info"
                aria-hidden="true"
              />
              {localPort === 0
                ? t("activity", "opensOnFreePort")
                : parts(t("activity", "opensAt"), {
                    address: (
                      <span className="font-mono text-fg">
                        http://localhost:{localPort}
                      </span>
                    ),
                  })}
            </p>
          )
        )}

        <div className="space-y-3 rounded-md border border-hair p-3">
          <ToggleRow
            label={t("activity", "autoReconnect")}
            hint={t("activity", "autoReconnectHint")}
            checked={autoReconnect}
            onChange={setAutoReconnect}
          />
          {canSave && (
            <ToggleRow
              label={t("activity", "saveAsConfig")}
              hint={t("activity", "saveAsConfigHint")}
              checked={saveConfig}
              onChange={setSaveConfig}
            />
          )}
          {/* Drawn whether or not saving is on, so turning it on does not
              grow the dialog and move Start out from under the pointer. */}
          {canSave && (
            <div
              className={cn(
                "space-y-3 transition-opacity",
                !saveConfig && "opacity-40"
              )}
            >
              <ToggleRow
                label={t("activity", "autoStartLabel")}
                hint={t("activity", "autoStartHint")}
                checked={autoStart}
                onChange={setAutoStart}
                disabled={!saveConfig}
              />
              <div className="grid gap-1.5">
                <Label htmlFor="pf-config-name">
                  {t("activity", "configName")}
                </Label>
                <Input
                  id="pf-config-name"
                  value={name}
                  disabled={!saveConfig}
                  onChange={(event) => setName(event.target.value)}
                  placeholder={`${target.name}:${remote}`}
                />
              </div>
            </div>
          )}
        </div>

        {active.length > 0 && (
          <div className="space-y-2">
            <Label>{t("activity", "activeForwards")}</Label>
            {active.map((session) => {
              const status = statusBySession[session.id];
              return (
                <div
                  key={session.id}
                  className="flex items-center justify-between gap-3 rounded-md border border-hair p-2.5 text-sm"
                >
                  <div className="min-w-0">
                    <div className="truncate font-mono text-xs">
                      localhost:{session.localPort} → {session.pod}:
                      {session.remotePort}
                    </div>
                    <div className="truncate text-[11px] text-fg-mut">
                      {forwardNoteWords(status?.note, t) ??
                        t("activity", "activeFallback")}
                    </div>
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      stopSession(session.id).catch((error) =>
                        toastError(t("activity", "stopForwardFailed"), error)
                      )
                    }
                  >
                    <Square className="mr-1 h-3 w-3" aria-hidden="true" />
                    {t("action", "stop")}
                  </Button>
                </div>
              );
            })}
          </div>
        )}
      </div>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onDone}>
          {t("action", "cancel")}
        </Button>
        <ReasonTip reason={denied}>
          <Button
            type="button"
            onClick={() => !denied && submit()}
            disabled={!denied && busy}
            aria-disabled={denied ? true : undefined}
            className={cn(denied && "cursor-default opacity-40")}
          >
            {busy ? t("action", "starting") : t("action", "startPortForward")}
          </Button>
        </ReasonTip>
      </DialogFooter>
    </>
  );
}

function ToggleRow({
  label,
  hint,
  checked,
  onChange,
  disabled,
}: {
  label: string;
  hint: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <label className="flex items-center justify-between gap-3">
      <span>
        <span className="block text-sm font-medium">{label}</span>
        <span className="block text-xs text-fg-mut">{hint}</span>
      </span>
      <Switch
        checked={checked}
        onCheckedChange={onChange}
        disabled={disabled}
      />
    </label>
  );
}
