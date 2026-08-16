/** Predefined debug container images */
export const DEBUG_IMAGES = [
  { label: "BusyBox (minimal)", value: "busybox:latest" },
  { label: "Alpine (shell + apk)", value: "alpine:latest" },
  { label: "Netshoot (network tools)", value: "nicolaka/netshoot:latest" },
  { label: "Ubuntu", value: "ubuntu:latest" },
  { label: "Custom...", value: "custom" },
] as const;
