import { describe, expect, it } from "vitest";

import {
  newerVersion,
  parseChangelog,
  releaseOf,
  releasesSince,
} from "./changelog";

const SAMPLE = `# Changelog

## [4.13.0] - 2026-09-12

### Added

- **Credentials renew themselves.** A plugin names the moment,
  and Rubick acts on it.
  - A plugin that needs a person is left alone.
- **Second item.**

### Fixed

- **A flash is gone.**

## [4.12.0] - 2026-09-11

### Added

- **Files tab on a pod.**
`;

describe("parseChangelog", () => {
  /** The release workflow reads the same headings; a section it cannot find is a release note nobody sees. */
  it("reads versions, sections, bullets and their sub-bullets", () => {
    const releases = parseChangelog(SAMPLE);
    expect(releases.map((r) => [r.version, r.date])).toEqual([
      ["4.13.0", "2026-09-12"],
      ["4.12.0", "2026-09-11"],
    ]);
    const [added, fixed] = releases[0].sections;
    expect(added.title).toBe("Added");
    expect(added.items.map((i) => i.text)).toEqual([
      "**Credentials renew themselves.** A plugin names the moment, and Rubick acts on it.",
      "**Second item.**",
    ]);
    expect(added.items[0].children.map((i) => i.text)).toEqual([
      "A plugin that needs a person is left alone.",
    ]);
    expect(fixed.items).toHaveLength(1);
  });
});

describe("releasesSince", () => {
  const releases = parseChangelog(SAMPLE);

  /** A first launch has nothing to announce; an update announces everything between. */
  it("is empty on a first launch and lists what arrived since otherwise", () => {
    expect(releasesSince(releases, null, "4.13.0")).toEqual([]);
    expect(
      releasesSince(releases, "4.12.0", "4.13.0").map((r) => r.version)
    ).toEqual(["4.13.0"]);
    expect(
      releasesSince(releases, "4.11.0", "4.13.0").map((r) => r.version)
    ).toEqual(["4.13.0", "4.12.0"]);
    expect(releasesSince(releases, "4.13.0", "4.13.0")).toEqual([]);
  });

  it("compares versions by number, not by string", () => {
    expect(newerVersion("4.10.0", "4.9.2")).toBe(true);
    expect(newerVersion("4.9.2", "4.10.0")).toBe(false);
    expect(newerVersion("dev", "4.10.0")).toBe(false);
    expect(releaseOf(releases, "4.12.0")?.date).toBe("2026-09-11");
    expect(releaseOf(releases, "9.9.9")).toBeNull();
  });
});
