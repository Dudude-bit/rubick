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

  // What kubectl's derivation produces beyond the plain reasons. Without
  // these every one of them fell through to neutral grey — the loudest
  // states in the cluster rendered as the quietest thing on the page.
  it("reads an init container's failure through its prefix", () => {
    expect(statusRole("Init:CrashLoopBackOff")).toBe("err");
    expect(statusRole("Init:ImagePullBackOff")).toBe("err");
    expect(statusRole("Init:ExitCode:1")).toBe("err");
    expect(statusRole("Init:Signal:9")).toBe("err");
  });

  it("treats init progress as pending, not as a failure", () => {
    expect(statusRole("Init:0/2")).toBe("pending");
    expect(statusRole("Init:1/3")).toBe("pending");
  });

  it("maps a bare exit code by whether it is clean", () => {
    expect(statusRole("ExitCode:0")).toBe("neutral");
    expect(statusRole("ExitCode:137")).toBe("err");
    expect(statusRole("Signal:11")).toBe("err");
  });

  it("keeps a healthy pod quiet", () => {
    expect(statusRole("Running")).toBe("ok");
  });
});
