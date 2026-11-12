/**
 * Predefined debug container images.
 *
 * The image names are their own; what each one buys you is a catalogue key,
 * because this table is read at import.
 */
export const DEBUG_IMAGES = [
  { label: "debugBusybox", value: "busybox:latest" },
  { label: "debugAlpine", value: "alpine:latest" },
  { label: "debugNetshoot", value: "nicolaka/netshoot:latest" },
  { label: "debugUbuntu", value: "ubuntu:latest" },
  { label: "debugCustom", value: "custom" },
] as const;
