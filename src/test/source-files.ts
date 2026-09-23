import { readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";

const root = join(import.meta.dirname, "..", "..");

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? walk(path) : [path];
  });
}

/**
 * Every file under `src/`, as a path from the repository root with forward
 * slashes (`src/lib/utils.ts`), for the guards that read the source as text.
 *
 * Nothing is skipped: not tests, not `generated/`, not other extensions. Seven
 * guards once walked the tree with their own copies of this and disagreed
 * about all three, so one of them could not see a file another one did. A
 * guard that wants fewer files filters this list where a reader can see it.
 * A symlinked directory is listed, not followed.
 */
export const SOURCE_FILES: readonly string[] = walk(join(root, "src"))
  .map((path) => relative(root, path).split(sep).join("/"))
  .sort();

export const isTest = (path: string) => /\.test\.tsx?$/.test(path);

/** What a guard reads unless it says otherwise: every `.ts` and `.tsx` that is not a test. */
export const CODE_FILES: readonly string[] = SOURCE_FILES.filter(
  (path) => /\.tsx?$/.test(path) && !isTest(path)
);

/** The files under one directory, `src/components/logs` for instance. */
export const filesUnder = (dir: string): string[] =>
  SOURCE_FILES.filter((path) => path.startsWith(`${dir}/`));
