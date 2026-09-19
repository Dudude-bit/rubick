import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) sources(path, out);
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name))
      out.push(path);
  }
  return out;
}

describe("asking to be told when", () => {
  /**
   * `ask` is two things: usually it starts a watch, but past the per-cluster
   * cap it stores a pending replacement and waits for `dialog` to ask which
   * watch to give up. A caller that never mounts `dialog` therefore works
   * until the twelfth watch and then silently stops starting them — no
   * error, no dialog, and the rollout the reader asked about is not
   * followed. The DaemonSet page shipped exactly that.
   *
   * `useAsk` itself is excluded: it is where `dialog` is built.
   */
  it("is mounted by every file that asks", () => {
    const unmounted = sources("src")
      .filter((path) => !path.endsWith("useAsk.tsx"))
      .filter((path) => {
        const text = readFileSync(path, "utf8");
        return /\buseAsk\(\)/.test(text) && !/\.dialog\}/.test(text);
      })
      .map((path) => path.replace(/^src\//, ""));
    expect(unmounted).toEqual([]);
  });

  /** A guard that reads nothing passes forever. */
  it("reads the files it is meant to be checking", () => {
    const callers = sources("src").filter((path) =>
      /\buseAsk\(\)/.test(readFileSync(path, "utf8"))
    );
    expect(callers.length).toBeGreaterThan(3);
  });
});
