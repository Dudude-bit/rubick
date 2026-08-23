/**
 * Encapsulates pod port-forward state for the Pod detail page:
 * form state, open/close, busy flag, start/stop handlers, and the
 * filtered list of currently-active sessions for this pod.
 *
 * Extracted from PodDetail.tsx so the page doesn't have to manage
 * 8 useState calls + 4 handlers + the parsePortValue dance.
 */

import { useCallback, useState } from "react";

import { useToast } from "@/components/ui/use-toast";
import { useT } from "@/i18n/useT";
import { usePortForwardStore } from "@/stores/portForwardStore";
import { useClusterStore } from "@/stores/clusterStore";
import type { PodInfo } from "@/generated/types";

import type { PortForwardFormState } from "./PodPortForwardDialog";

const INITIAL_FORM: PortForwardFormState = {
  name: "",
  localPort: "",
  remotePort: "",
  autoReconnect: true,
  autoStart: false,
  saveConfig: true,
};

function parsePortValue(value: string): number | null {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) {
    return null;
  }
  return parsed;
}

export function usePodPortForward(pod: PodInfo | undefined) {
  const { toast } = useToast();
  const t = useT();
  const currentContext = useClusterStore((state) => state.currentContext);

  const addPortForwardConfig = usePortForwardStore((state) => state.addConfig);
  const startPortForwardConfig = usePortForwardStore(
    (state) => state.startConfig
  );
  const startPortForwardPod = usePortForwardStore((state) => state.startPod);
  const portForwardSessions = usePortForwardStore((state) => state.sessions);
  const stopPortForwardSession = usePortForwardStore(
    (state) => state.stopSession
  );
  const portForwardStatusBySession = usePortForwardStore(
    (state) => state.statusBySession
  );

  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState<PortForwardFormState>(INITIAL_FORM);

  const openDialog = useCallback(() => {
    if (!pod) return;
    setForm({ ...INITIAL_FORM, name: pod.name });
    setOpen(true);
  }, [pod]);

  const handleSubmit = useCallback(async () => {
    if (!pod) return;
    if (!currentContext) {
      toast({
        title: t("action", "noClusterSelected"),
        description: "Connect to a cluster to start port-forwarding.",
        variant: "destructive",
      });
      return;
    }

    const localPort = parsePortValue(form.localPort);
    const remotePort = parsePortValue(form.remotePort);

    if (!localPort || !remotePort) {
      toast({
        title: "Invalid port",
        description: t("action", "portsOutOfRange"),
        variant: "destructive",
      });
      return;
    }

    setBusy(true);
    try {
      if (form.saveConfig) {
        const config = await addPortForwardConfig({
          context: currentContext,
          name: form.name.trim() || `${pod.name}:${remotePort}`,
          pod: pod.name,
          namespace: pod.namespace,
          localPort,
          remotePort,
          autoReconnect: form.autoReconnect,
          autoStart: form.autoStart,
        });
        await startPortForwardConfig(config.id);
      } else {
        await startPortForwardPod(pod.name, pod.namespace, {
          localPort,
          remotePort,
          autoReconnect: form.autoReconnect,
        });
      }

      setOpen(false);
    } catch (err) {
      toast({
        title: t("action", "portForwardStartFailed"),
        description: String(err),
        variant: "destructive",
      });
    } finally {
      setBusy(false);
    }
  }, [
    pod,
    currentContext,
    form,
    addPortForwardConfig,
    startPortForwardConfig,
    startPortForwardPod,
    toast,
    t,
  ]);

  const handleStopSession = useCallback(
    async (sessionId: string) => {
      try {
        await stopPortForwardSession(sessionId);
      } catch (err) {
        toast({
          title: t("action", "portForwardStopFailed"),
          description: String(err),
          variant: "destructive",
        });
      }
    },
    [stopPortForwardSession, toast, t]
  );

  const activePortForwards =
    pod && portForwardSessions
      ? portForwardSessions.filter(
          (session) =>
            session.context === currentContext &&
            session.pod === pod.name &&
            session.namespace === pod.namespace
        )
      : [];

  return {
    open,
    setOpen,
    openDialog,
    form,
    setForm,
    busy,
    handleSubmit,
    handleStopSession,
    activePortForwards,
    portForwardStatusBySession,
  };
}
