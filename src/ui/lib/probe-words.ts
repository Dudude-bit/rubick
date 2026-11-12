import type { ProbeInfo } from "@/generated/types";

/**
 * A probe the way `kubectl describe` prints it, so the line can be matched
 * against a terminal: `http-get http://:http/healthz` and then
 * `delay=0s timeout=1s period=5s #success=1 #failure=3`.
 */
export function describeProbe(probe: ProbeInfo): {
  target: string;
  timing: string;
} {
  const timing = `delay=${probe.initialDelaySeconds}s timeout=${probe.timeoutSeconds}s period=${probe.periodSeconds}s #success=${probe.successThreshold} #failure=${probe.failureThreshold}`;
  const { handler } = probe;
  switch (handler.type) {
    case "httpGet":
      return {
        target: `http-get ${handler.scheme.toLowerCase()}://${handler.host ?? ""}:${handler.port}${handler.path}`,
        timing,
      };
    case "tcpSocket":
      return { target: `tcp-socket :${handler.port}`, timing };
    case "exec":
      return { target: `exec [${handler.command.join(" ")}]`, timing };
    case "grpc":
      return {
        target: `grpc <pod>:${handler.port}${handler.service ? ` ${handler.service}` : ""}`,
        timing,
      };
    case "unknown":
      return { target: "unknown", timing };
  }
}

/** The kubectl label each probe is printed under. */
export const PROBE_LABEL = {
  readiness: "Readiness",
  liveness: "Liveness",
  startup: "Startup",
} as const;

/** A probe as the API's own field paths, for comparing two revisions field by field. */
export function probeFields(
  field: string,
  probe: ProbeInfo | null
): Map<string, string> {
  const out = new Map<string, string>();
  if (!probe) return out;
  const at = (name: string, value: string | number | null) => {
    if (value !== null) out.set(`${field}.${name}`, String(value));
  };
  const { handler } = probe;
  switch (handler.type) {
    case "httpGet":
      at("httpGet.path", handler.path);
      at("httpGet.port", handler.port);
      at("httpGet.scheme", handler.scheme);
      at("httpGet.host", handler.host);
      break;
    case "tcpSocket":
      at("tcpSocket.port", handler.port);
      break;
    case "exec":
      at("exec.command", handler.command.join(" "));
      break;
    case "grpc":
      at("grpc.port", handler.port);
      at("grpc.service", handler.service);
      break;
    case "unknown":
      at("handler", "unknown");
      break;
  }
  at("initialDelaySeconds", probe.initialDelaySeconds);
  at("periodSeconds", probe.periodSeconds);
  at("timeoutSeconds", probe.timeoutSeconds);
  at("successThreshold", probe.successThreshold);
  at("failureThreshold", probe.failureThreshold);
  return out;
}
