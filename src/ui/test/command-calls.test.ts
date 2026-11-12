import { readFileSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";

import kinds from "../../contracts/kinds.json";

import { CODE_FILES } from "@/test/source-files";

const read = (path: string) => readFileSync(path, "utf8");

/** The parameter names of every generated command, in order. */
const PARAMS = new Map(
  [
    ...read("src/ui/generated/commands.ts").matchAll(
      /^export async function (\w+)\(([^)]*)\)/gm
    ),
  ].map(([, name, list]) => [
    name,
    [...list.matchAll(/(?:^|,)\s*(\w+)\??:/g)].map(([, param]) => param),
  ])
);

interface Call {
  path: string;
  line: number;
  command: string;
  args: string[];
  /** The object key the call stands under, where it stands in a table. */
  key: string | null;
}

/** The arguments of the call whose `(` is at `open`, split at the top level. */
function argsAt(source: string, open: number): string[] {
  const args: string[] = [];
  let depth = 0;
  let from = open + 1;
  for (let at = open; at < source.length; at++) {
    const char = source[at];
    if ("([{".includes(char)) depth++;
    else if (")]}".includes(char)) depth--;
    if (depth === 1 && char === ",") {
      args.push(source.slice(from, at));
      from = at + 1;
    }
    if (depth === 0) {
      args.push(source.slice(from, at));
      break;
    }
  }
  return args.map((arg) => arg.trim()).filter((arg) => arg !== "");
}

const CALLS: Call[] = CODE_FILES.filter(
  (path) =>
    !path.startsWith("src/ui/generated/") && path !== "src/ui/lib/commands.ts"
).flatMap((path) => {
  const source = read(path);
  return [...source.matchAll(/\bcommands\.(\w+)\(/g)].map((match) => {
    const before = source.slice(Math.max(0, match.index - 160), match.index);
    const key = /(?:^|\n)\s*(\w+):\s*(?:async\s*)?\([^()]*\)\s*=>\s*$/.exec(
      before
    );
    return {
      path,
      line: source.slice(0, match.index).split("\n").length,
      command: match[1],
      args: argsAt(source, match.index + match[0].length - 1),
      key: key ? key[1] : null,
    };
  });
});

/**
 * The names an argument is read by: `item.namespace ?? null` is `item` and
 * `namespace`. An expression that is no plain chain names nothing.
 */
function names(arg: string): string[] {
  const bare = arg.replace(/\s*(\|\||\?\?)\s*(null|undefined|"")$/, "");
  if (!/^[\w.?!]+$/.test(bare)) return [];
  return bare
    .replace(/[?!]/g, "")
    .split(".")
    .map((part) => (part === "ns" ? "namespace" : part.toLowerCase()));
}

const at = (call: Call) => `${call.path}:${call.line} ${call.command}`;

describe("a call to a command", () => {
  /**
   * `deleteService(item.namespace, item.name)` type-checks where both are
   * strings, and no test of 7 484 failed on it. Fails if an argument carries
   * the name of another parameter of the command it is passed to.
   */
  it("passes no argument in the slot of another parameter", () => {
    const misplaced = CALLS.flatMap((call) => {
      const params = (PARAMS.get(call.command) ?? []).map((param) =>
        param.toLowerCase()
      );
      return call.args.flatMap((arg, slot) => {
        const said = names(arg);
        const last = said.at(-1);
        const belongs = last === undefined ? -1 : params.indexOf(last);
        // `owner.uid` passed as `owner` names its own slot on the way.
        return belongs >= 0 && !said.includes(params[slot])
          ? [`${at(call)}: ${arg} is passed as ${params[slot]}`]
          : [];
      });
    });
    expect(misplaced).toEqual([]);
  });

  /** A guard that found no call would pass against anything. */
  it("is read from the source with its arguments", () => {
    const deletes = CALLS.filter((call) => /^delete/.test(call.command));
    expect(deletes.length).toBeGreaterThan(40);
    expect(deletes.every((call) => call.args.length >= 1)).toBe(true);
    expect(PARAMS.get("scaleDeployment")).toEqual([
      "name",
      "replicas",
      "namespace",
    ]);
  });
});

describe("a command that changes one kind", () => {
  const KINDS = new Map(
    kinds.kinds.map(({ kind }) => [kind.toLowerCase(), kind])
  );
  /** Command nouns that are not spelled as their kind. */
  const NOUN: Record<string, string> = { crd: "customresourcedefinition" };
  const ROUTES = ["HTTPRoute", "GRPCRoute", "TLSRoute", "TCPRoute", "UDPRoute"];

  /** The kind a command is for, where its name says one: `restartDaemonset` is DaemonSet's. */
  function kindOf(call: Call): string | null {
    const noun = /^(?:delete|restart|scale|trigger|suspend|resume)(\w+)$/
      .exec(call.command)?.[1]
      .toLowerCase();
    if (noun === undefined) return null;
    if (noun === "gatewayroute")
      return call.args[0]?.replace(/^"|"$/g, "") ?? null;
    return KINDS.get(NOUN[noun] ?? noun) ?? null;
  }

  /** The kind of the place a call is written in: its table key, else the page its file is. */
  function placeOf(call: Call): string | null {
    if (
      call.key !== null &&
      (KINDS.has(call.key.toLowerCase()) || ROUTES.includes(call.key))
    )
      return call.key;
    const page = /\/(\w+?)(?:Detail|List)\.tsx$/.exec(call.path)?.[1];
    return page !== undefined && KINDS.has(page.toLowerCase()) ? page : null;
  }

  /**
   * `Deployment: (name, namespace) => commands.deleteStatefulset(…)` has the
   * signature of the right one, and no test failed on it either. Fails if a
   * table row or a kind's own page calls the command of another kind, other
   * than the ones listed with why.
   */
  it("is called for that kind, in its table row and on its page", () => {
    const another = CALLS.flatMap((call) => {
      const kind = kindOf(call);
      const place = placeOf(call);
      return kind !== null && place !== null && kind !== place
        ? [`${at(call)} under ${place}`]
        : [];
    });
    expect(another).toEqual([]);
  });

  /** The rule above is only as good as the places it can name. */
  it("is found in every row of the peek's tables and on every page of a kind", () => {
    const placed = CALLS.filter(
      (call) => kindOf(call) !== null && placeOf(call) !== null
    );
    const tables = placed.filter((call) =>
      call.path.endsWith("peek-actions.ts")
    );
    expect(tables.length).toBeGreaterThan(20);
    expect(placed.length - tables.length).toBeGreaterThan(30);
  });
});
