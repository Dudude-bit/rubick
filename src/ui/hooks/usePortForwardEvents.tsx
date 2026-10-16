import { useEffect, useRef } from "react";
import { ToastAction } from "@/components/ui/toast";
import { useToast } from "@/components/ui/use-toast";
import { useActivityPanelStore } from "@/stores/activityPanelStore";
import { usePortForwardStore } from "@/stores/portForwardStore";
import { useT } from "@/i18n/useT";
import { listenEvent } from "@/lib/events";
import { forwardNoteWords } from "@/lib/port-forward";

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

  // A lag can drop a forward's `stopped`; the backend's list is the only
  // other place that knows it ended.
  useEffect(() => {
    const off = listenEvent("event-bridge-lagged", () => {
      void refreshSessions().catch(() => {});
    });
    return () => {
      void off.then((stop) => stop());
    };
  }, [refreshSessions]);

  useEffect(() => {
    let unlisten: null | (() => void) = null;

    listenEvent("port-forward-status", (event) => {
      const payload = event.payload;
      const store = usePortForwardStore.getState();

      setStatus({
        id: payload.id,
        pod: payload.pod,
        namespace: payload.namespace,
        localPort: payload.local_port,
        remotePort: payload.remote_port,
        status: payload.status,
        note: payload.note,
        attempt: payload.attempt,
      });
      if (payload.status === "moved") {
        store.moved(payload.id, payload.pod, payload.remote_port);
      }
      if (payload.status === "failed") {
        store.fail(payload.id, payload.note);
      }

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

      const base = `localhost:${payload.local_port} → ${payload.pod}:${payload.remote_port}`;
      const note = forwardNoteWords(payload.note, t);
      const message = note ? `${base} · ${note}` : base;

      // The toast is where somebody first learns a forward exists, and where
      // they learn it is in trouble, so it is also the shortest way to the
      // panel that manages it.
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
            description: base,
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
        case "moved":
          toast({
            title: t("activity", "forwardMovedTitle"),
            description: message,
            action: manage,
          });
          break;
        case "stopped":
          toast({
            title: t("action", "portForwardStopped"),
            description: base,
          });
          refreshSessions();
          break;
        case "failed":
          toast({
            title: t("activity", "forwardFailedTitle"),
            description: message,
            action: manage,
            variant: "destructive",
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
