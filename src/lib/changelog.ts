/**
 * `CHANGELOG.md`, read the way the release workflow reads it: one `## [x.y.z]`
 * heading per version, `###` sections under it, bullets with two spaces of
 * indent for a sub-bullet. Nothing more is understood, because nothing more
 * is written there.
 */

export interface ChangeItem {
  text: string;
  children: ChangeItem[];
}

export interface ChangeSection {
  title: string;
  items: ChangeItem[];
}

export interface Release {
  version: string;
  date: string | null;
  sections: ChangeSection[];
}

const HEADING = /^## \[([^\]]+)\](?:\s*-\s*(\S+))?/;

export function parseChangelog(markdown: string): Release[] {
  const releases: Release[] = [];
  let release: Release | null = null;
  let section: ChangeSection | null = null;
  let last: ChangeItem | null = null;
  let lastChild: ChangeItem | null = null;

  for (const line of markdown.split("\n")) {
    const heading = HEADING.exec(line);
    if (heading) {
      release = { version: heading[1], date: heading[2] ?? null, sections: [] };
      releases.push(release);
      section = null;
      last = null;
      lastChild = null;
      continue;
    }
    if (!release) continue;
    if (line.startsWith("### ")) {
      section = { title: line.slice(4).trim(), items: [] };
      release.sections.push(section);
      last = null;
      lastChild = null;
      continue;
    }
    if (!section) continue;
    if (line.startsWith("- ")) {
      last = { text: line.slice(2).trim(), children: [] };
      section.items.push(last);
      lastChild = null;
    } else if (line.startsWith("  - ") && last) {
      lastChild = { text: line.slice(4).trim(), children: [] };
      last.children.push(lastChild);
    } else if (line.startsWith("    ") && lastChild) {
      lastChild.text += ` ${line.trim()}`;
    } else if (line.startsWith("  ") && last) {
      last.text += ` ${line.trim()}`;
    }
  }
  return releases;
}

/** `a` newer than `b`, by the three numbers; anything unreadable is not newer. */
export function newerVersion(a: string, b: string): boolean {
  const parse = (v: string) => v.split(/[.-]/).slice(0, 3).map(Number);
  const [x, y] = [parse(a), parse(b)];
  if (x.some(Number.isNaN) || y.some(Number.isNaN)) return false;
  for (let i = 0; i < 3; i++) {
    if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  }
  return false;
}

/**
 * What arrived between the version last seen and the one running: every
 * release newer than `seen` up to and including `current`, newest first. A
 * `seen` of `null` is a first launch, and a first launch has nothing new.
 */
export function releasesSince(
  releases: Release[],
  seen: string | null,
  current: string
): Release[] {
  if (seen === null) return [];
  return releases.filter(
    (release) =>
      newerVersion(release.version, seen) &&
      !newerVersion(release.version, current)
  );
}

/** The one release the running version has, or `null` if the file has no entry for it. */
export function releaseOf(
  releases: Release[],
  version: string
): Release | null {
  return releases.find((release) => release.version === version) ?? null;
}
