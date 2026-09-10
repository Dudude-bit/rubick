import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import type { PodVolumeInfo } from "@/generated/types";
import {
  DOWNLOAD_MAX_BYTES,
  MAX_ENTRIES,
  PREVIEW_MAX_BYTES,
  type FileEntry,
  crumbs,
  joinPath,
  modeText,
  mountFor,
  parentOf,
  sortEntries,
} from "./container-files";

const volumes: PodVolumeInfo[] = [
  {
    name: "config",
    source: "ConfigMap",
    refs: [{ kind: "ConfigMap", name: "demo-config" }],
    mounts: [
      { container: "app", path: "/etc/app", readOnly: true, subPath: null },
    ],
  },
  {
    name: "secret",
    source: "Secret",
    refs: [{ kind: "Secret", name: "demo-secret" }],
    mounts: [
      {
        container: "app",
        path: "/etc/app/password",
        readOnly: true,
        subPath: "password",
      },
    ],
  },
  {
    name: "scratch",
    source: "EmptyDir",
    refs: [],
    mounts: [
      {
        container: "sidecar",
        path: "/scratch",
        readOnly: false,
        subPath: null,
      },
    ],
  },
];

const entry = (over: Partial<FileEntry>): FileEntry => ({
  name: "x",
  kind: "file",
  mode: "644",
  size: 0,
  modified: null,
  owner: "root",
  group: "root",
  target: null,
  ...over,
});

describe("mountFor", () => {
  /** The tag is the pod's own fact; a file under two mounts belongs to the inner one. */
  it("names the deepest mount of this container that the path sits under", () => {
    expect(mountFor("/etc/app/app.conf", "app", volumes)).toEqual({
      kind: "ConfigMap",
      name: "demo-config",
      at: "/etc/app",
    });
    expect(mountFor("/etc/app/password", "app", volumes)).toEqual({
      kind: "Secret",
      name: "demo-secret",
      at: "/etc/app/password",
    });
  });

  it("does not borrow another container's mounts", () => {
    expect(mountFor("/scratch/tmp", "app", volumes)).toBeNull();
    expect(mountFor("/scratch/tmp", "sidecar", volumes)?.kind).toBe("EmptyDir");
  });

  it("does not match a sibling that merely shares a prefix", () => {
    expect(mountFor("/etc/application", "app", volumes)).toBeNull();
  });
});

describe("paths", () => {
  it("joins and climbs without doubling the root slash", () => {
    expect(joinPath("/", "etc")).toBe("/etc");
    expect(joinPath("/etc", "app")).toBe("/etc/app");
    expect(parentOf("/etc/app")).toBe("/etc");
    expect(parentOf("/etc")).toBe("/");
    expect(parentOf("/")).toBe("/");
    expect(crumbs("/etc/app").map((c) => c.path)).toEqual([
      "/",
      "/etc",
      "/etc/app",
    ]);
  });
});

describe("sortEntries", () => {
  it("keeps directories first whatever the key", () => {
    const sorted = sortEntries(
      [
        entry({ name: "b.txt", size: 2 }),
        entry({ name: "conf.d", kind: "dir" }),
        entry({ name: "a.txt", size: 9 }),
      ],
      "size",
      true
    );
    expect(sorted.map((e) => e.name)).toEqual(["conf.d", "a.txt", "b.txt"]);
  });
});

describe("modeText", () => {
  it("writes the mode the way ls does, with the kind in front", () => {
    expect(modeText(entry({ mode: "755", kind: "dir" }))).toBe("drwxr-xr-x");
    expect(modeText(entry({ mode: "400" }))).toBe("-r--------");
    expect(modeText(entry({ mode: "777", kind: "symlink" }))).toBe(
      "lrwxrwxrwx"
    );
  });
});

describe("the caps both halves apply", () => {
  /**
   * A comment saying "mirrored" is not a check. The download cap was spelled
   * three times — a literal in the tab, `DOWNLOAD_MAX_BYTES` in Rust and a
   * number inside the catalogue sentence — with nothing holding them equal.
   * Fails if this side drifts from `shared/file-limits.json`.
   */
  it("matches shared/file-limits.json", () => {
    const shared = JSON.parse(
      readFileSync(resolve(process.cwd(), "shared/file-limits.json"), "utf8")
    ) as {
      downloadMaxBytes: number;
      previewMaxBytes: number;
      maxEntries: number;
    };
    expect(DOWNLOAD_MAX_BYTES).toBe(shared.downloadMaxBytes);
    expect(PREVIEW_MAX_BYTES).toBe(shared.previewMaxBytes);
    expect(MAX_ENTRIES).toBe(shared.maxEntries);
  });
});
