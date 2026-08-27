import { describe, expect, it } from "vitest";
import {
  ROLE_DOT,
  ROLE_ICON,
  ROLE_TEXT,
  statusRole,
  type StatusRole,
} from "@/lib/status-role";
import { RESOURCE_REGISTRY } from "@/lib/resource-registry";

const ROLES: StatusRole[] = ["ok", "pending", "warn", "err", "neutral"];

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

describe("role marks", () => {
  it("gives every role its own shape", () => {
    // Hue is the channel a greyscale screenshot and a red-green deficiency
    // both lose. If two roles shared a glyph, a condition list or a container
    // block would be saying one thing in one channel.
    expect(new Set(ROLES.map((role) => ROLE_ICON[role])).size).toBe(
      ROLES.length
    );
  });

  it("never reuses a kind's glyph", () => {
    // A status mark and a `ResourceRef`'s kind mark sit in adjacent columns
    // of the same table row; sharing one collapses two channels into one.
    const kinds = new Set(RESOURCE_REGISTRY.map((entry) => entry.icon));
    for (const role of ROLES) expect(kinds.has(ROLE_ICON[role])).toBe(false);
  });

  it("answers every role in every channel", () => {
    for (const role of ROLES) {
      expect(ROLE_TEXT[role]).toMatch(/^text-/);
      expect(ROLE_DOT[role]).toMatch(/^bg-/);
    }
  });
  /**
   * A status the table does not know falls to `neutral`, and the badge draws
   * the same grey glyph for "the controller accepted this" as for "the
   * controller refused it". The Gateway API surfaces added five of these.
   */
  it("colours the Gateway API verdicts", () => {
    expect(statusRole("Accepted")).toBe("ok");
    expect(statusRole("Programmed")).toBe("ok");
    expect(statusRole("Claimed")).toBe("ok");
    expect(statusRole("Refused")).toBe("err");
    expect(statusRole("Unclaimed")).toBe("neutral");
  });
});
