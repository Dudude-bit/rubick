import { useEffect, useRef } from "react";
import { useClusterStore } from "@/stores/clusterStore";
import { usePortForwardStore } from "@/stores/portForwardStore";

export function usePortForwardAutoStart() {
  const currentContext = useClusterStore((state) => state.currentContext);
  const isConnected = useClusterStore((state) => state.isConnected);
  const configsLoaded = usePortForwardStore((state) => state.configsLoaded);
  const startAutoForContext = usePortForwardStore(
    (state) => state.startAutoForContext
  );
  const lastContextRef = useRef<string | null>(null);

  useEffect(() => {
    if (!isConnected) {
      lastContextRef.current = null;
      return;
    }
    if (!currentContext || !configsLoaded) {
      return;
    }
    if (lastContextRef.current === currentContext) {
      return;
    }
    startAutoForContext(currentContext).catch((error) => {
      console.error("Failed to auto-start port-forwards:", error);
    });
    lastContextRef.current = currentContext;
  }, [configsLoaded, currentContext, isConnected, startAutoForContext]);
}
