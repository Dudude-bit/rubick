import { describe, expect, it } from "vitest";
import { statusRole } from "@/lib/status-role";

describe("statusRole", () => {
  it("maps healthy states", () => {
    for (const s of [
      "Running",
      "Ready",
      "Available",
      "Active",
      "Succeeded",
      "Bound",
      "deployed",
    ])
      expect(statusRole(s)).toBe("ok");
  });

  it("maps in-flight states", () => {
    for (const s of [
      "Pending",
      "Waiting",
      "Progressing",
      "Creating",
      "pending-install",
    ])
      expect(statusRole(s)).toBe("pending");
  });

  it("maps degraded states", () => {
    for (const s of ["Warning", "Degraded", "Suspended"])
      expect(statusRole(s)).toBe("warn");
  });

  it("maps failures", () => {
    for (const s of [
      "Error",
      "Failed",
      "CrashLoopBackOff",
      "Evicted",
      "OOMKilled",
      "ImagePullBackOff",
    ])
      expect(statusRole(s)).toBe("err");
  });

  it("maps terminal and unknown states to neutral", () => {
    for (const s of ["Completed", "Terminated", "Superseded", "", "wat"])
      expect(statusRole(s)).toBe("neutral");
  });

  it("ignores case, spaces and dashes", () => {
    expect(statusRole("crash loop back off")).toBe("err");
    expect(statusRole("CRASH-LOOP-BACK-OFF")).toBe("err");
  });
});
