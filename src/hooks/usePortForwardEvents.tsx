import { useEffect, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import { ToastAction } from "@/components/ui/toast";
import { useToast } from "@/components/ui/use-toast";
import { useActivityPanelStore } from "@/stores/activityPanelStore";
import { usePortForwardStore } from "@/stores/portForwardStore";
import { useT } from "@/i18n/useT";

interface PortForwardEventPayload {
  id: string;
  pod: string;
  namespace: string;
  local_port: number;
  remote_port: number;
  status: string;
  message?: string | null;
  attempt?: number | null;
}

const DEDUPE_MS = 2500;

export function usePortForwardEvents() {
  const t = useT();
  const { toast } = useToast();
  const setStatus = usePortForwardStore((state) => state.setStatus);
  const openActivityOn = useActivityPanelStore((state) => state.openOn);
  const refreshSessions = usePortForwardStore((state) => state.refreshSessions);
  const lastToastRef = useRef<Record<string, { status: string; time: number }>>(
    {}
  );

  useEffect(() => {
    let unlisten: null | (() => void) = null;

    listen<PortForwardEventPayload>("port-forward-status", (event) => {
      const payload = event.payload;

      setStatus({
        id: payload.id,
        pod: payload.pod,
        namespace: payload.namespace,
        localPort: payload.local_port,
        remotePort: payload.remote_port,
        status: payload.status,
        message: payload.message,
        attempt: payload.attempt,
      });

      const last = lastToastRef.current[payload.id];
      const now = Date.now();
      if (
        last &&
        last.status === payload.status &&
        now - last.time < DEDUPE_MS
      ) {
        return;
      }
      lastToastRef.current[payload.id] = { status: payload.status, time: now };

      const base = `${payload.local_port} → ${payload.pod}:${payload.remote_port}`;
      const message = payload.message || base;

      // The toast is where somebody first learns a forward exists, and where
      // they learn it is in trouble — so it is also the shortest way to the
      // panel that manages it. Without this the notification was a dead end
      // and the panel stayed unfound.
      const manage = (
        <ToastAction
          altText={t("action", "openPortForwardPanel")}
          onClick={() => openActivityOn("ports")}
        >
          {t("action", "manage")}
        </ToastAction>
      );

      switch (payload.status) {
        case "listening":
          toast({
            title: t("action", "portForwardActive"),
            description: message,
            action: manage,
          });
          break;
        case "reconnecting":
          toast({
            title: t("action", "portForwardReconnecting"),
            description: message,
            action: manage,
          });
          break;
        case "reconnected":
          toast({
            title: t("action", "portForwardReconnected"),
            description: base,
          });
          break;
        case "stopped":
          toast({
            title: t("action", "portForwardStopped"),
            description: base,
          });
          refreshSessions();
          break;
        case "error":
          toast({
            title: t("action", "portForwardError"),
            description: message,
            action: manage,
            variant: "destructive",
          });
          refreshSessions();
          break;
        default:
          break;
      }
    }).then((fn) => {
      unlisten = fn;
    });

    return () => {
      if (unlisten) {
        unlisten();
      }
    };
  }, [openActivityOn, refreshSessions, setStatus, t, toast]);
}
