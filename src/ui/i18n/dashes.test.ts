import { readdirSync, readFileSync } from "node:fs";
import { parseSync } from "vite-plus";
import { describe, expect, it } from "vite-plus/test";

import { CODE_FILES } from "@/test/source-files";
import { en, type Plural } from "./catalogue";
import { ru } from "./ru";

const DASH = /[—–]/;

/** Every string a catalogue holds, each plural form on its own, by its path. */
function strings(catalogue: object): Array<[string, string]> {
  return Object.entries(catalogue).flatMap(([section, keys]) =>
    Object.entries(keys as Record<string, string | Plural>).flatMap(
      ([key, value]): Array<[string, string]> =>
        typeof value === "string"
          ? [[`${section}.${key}`, value]]
          : Object.entries(value).map(([form, text]) => [
              `${section}.${key}.${form}`,
              String(text),
            ])
    )
  );
}

/** Each line of a file that holds a dash anywhere but in a comment, as `path:line`. */
function dashedLines(path: string, source: string): string[] {
  if (!DASH.test(source)) return [];
  const code = source.split("");
  for (const comment of parseSync(path, source).comments)
    for (let i = comment.start; i < comment.end; i++)
      if (code[i] !== "\n") code[i] = " ";
  return code
    .join("")
    .split("\n")
    .flatMap((line, index) =>
      DASH.test(line) ? [`${path}:${index + 1}`] : []
    );
}

/** Each Rust string or char literal that holds a dash, as `path:line` of the dash. */
function dashedRustLiterals(path: string, source: string): string[] {
  if (!DASH.test(source)) return [];
  const found = new Set<string>();
  const chars = Array.from(source);
  let line = 1;
  let i = 0;
  const step = () => {
    if (chars[i] === "\n") line++;
    i++;
  };
  const word = /[A-Za-z0-9_]/;
  while (i < chars.length) {
    const c = chars[i];
    const next = chars[i + 1];
    if (c === "/" && next === "/") {
      while (i < chars.length && chars[i] !== "\n") step();
    } else if (c === "/" && next === "*") {
      let depth = 0;
      do {
        if (chars[i] === "/" && chars[i + 1] === "*") {
          depth++;
          step();
        } else if (chars[i] === "*" && chars[i + 1] === "/") {
          depth--;
          step();
        }
        step();
      } while (depth > 0 && i < chars.length);
    } else if (
      c === '"' ||
      (c === "'" && (next === "\\" || chars[i + 2] === "'"))
    ) {
      step();
      while (i < chars.length && chars[i] !== c) {
        if (DASH.test(chars[i])) found.add(`${path}:${line}`);
        if (chars[i] === "\\") step();
        step();
      }
      step();
    } else if (
      /[rb]/.test(c) &&
      !word.test(chars[i - 1] ?? "") &&
      /^(b?r#*"|br#*")/.test(chars.slice(i, i + 16).join(""))
    ) {
      while (chars[i] !== "r") step();
      step();
      let hashes = 0;
      while (chars[i] === "#") {
        hashes++;
        step();
      }
      step();
      const close = '"' + "#".repeat(hashes);
      while (
        i < chars.length &&
        chars.slice(i, i + close.length).join("") !== close
      ) {
        if (DASH.test(chars[i])) found.add(`${path}:${line}`);
        step();
      }
      for (let k = 0; k < close.length; k++) step();
    } else {
      step();
    }
  }
  return [...found];
}

function rustFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) return rustFiles(path);
    return path.endsWith(".rs") ? [path] : [];
  });
}

/** Files whose "-" is a notation of its own: `ls` mode bits, a diff's removed line. */
const HYPHEN_NOTATION = new Set([
  "src/ui/lib/container-files.ts",
  "src/ui/routes/c/$cluster/-yaml/YamlDiffViewer.tsx",
]);

type Node = { type?: string; start: number; [key: string]: unknown };

/** Lines where a lone "-" is what a value falls back to, as `path:line`. */
function hyphenPlaceholders(path: string, source: string): string[] {
  if (!/["'`]-["'`]|>\s*-\s*<|^\s*-\s*$/m.test(source)) return [];
  const found: number[] = [];
  const visit = (node: unknown, parent: Node | null, inTemplate: boolean) => {
    if (Array.isArray(node)) {
      for (const child of node) visit(child, parent, inTemplate);
      return;
    }
    if (!node || typeof node !== "object") return;
    const current = node as Node;
    const hyphen =
      (current.type === "Literal" && current.value === "-") ||
      (current.type === "JSXText" && String(current.value).trim() === "-");
    const fallsBack =
      parent?.type === "LogicalExpression" ||
      parent?.type === "ConditionalExpression" ||
      parent?.type === "ReturnStatement" ||
      parent?.type === "ArrowFunctionExpression" ||
      parent?.type === "JSXAttribute" ||
      parent?.type === "JSXElement" ||
      parent?.type === "JSXExpressionContainer" ||
      parent?.type === "Property";
    if (hyphen && fallsBack && !inTemplate) found.push(current.start);
    const nested = inTemplate || current.type === "TemplateLiteral";
    for (const [key, child] of Object.entries(current))
      if (key !== "parent") visit(child, current, nested);
  };
  visit(parseSync(path, source).program, null, false);
  return found.map(
    (offset) => `${path}:${source.slice(0, offset).split("\n").length}`
  );
}

describe("the punctuation of the copy", () => {
  /** An em or en dash pasted into a string reaches the screen, and no other test, lint rule or scanner looks for one. */
  it.each([
    ["en", en],
    ["ru", ru],
  ])("keeps every %s string free of em and en dashes", (_locale, catalogue) => {
    const dashed = strings(catalogue)
      .filter(([, text]) => DASH.test(text))
      .map(([id]) => id);
    expect(dashed).toEqual([]);
  });

  /**
   * The catalogues were clean while the code around them still drew "—" for
   * every empty cell and glued labels with " — ". Fails on a dash in any JSX
   * text, attribute, string, template or regex under src/ui; comments may
   * keep theirs, and a pattern that has to match one spells it —.
   */
  it("keeps every em and en dash out of what the UI code draws", () => {
    const dashed = CODE_FILES.filter(
      (path) => !path.startsWith("src/ui/generated/")
    ).flatMap((path) => dashedLines(path, readFileSync(path, "utf8")));
    expect(dashed).toEqual([]);
  });

  /**
   * A TLS Secret's tls.key row read "a private key — the app never shows
   * one" on the Russian screen: the sentence came from Rust, which no scan
   * read. Fails on a dash in any string or char literal under src/tauri/src;
   * comments keep theirs, and code that must match one spells it \u{2014}.
   */
  it("keeps every em and en dash out of the strings the backend writes", () => {
    const dashed = rustFiles("src/tauri/src").flatMap((path) =>
      dashedRustLiterals(path, readFileSync(path, "utf8"))
    );
    expect(dashed).toEqual([]);
  });

  /**
   * Node page External IP drew "-" where a Service says "none", and the CRD
   * columns of istio, flux, traefik and others did the same. Fails on a lone
   * hyphen that a value falls back to, in code or in JSX text.
   */
  it("keeps a bare hyphen from standing in for an empty value", () => {
    const placeholders = CODE_FILES.filter(
      (path) =>
        !path.startsWith("src/ui/generated/") && !HYPHEN_NOTATION.has(path)
    ).flatMap((path) => hyphenPlaceholders(path, readFileSync(path, "utf8")));
    expect(placeholders).toEqual([]);
  });

  /** The scan itself: a fallback "-" is caught; a key built in a template and a split are not. */
  it("tells a hyphen standing in for a value from one inside a key", () => {
    const source = [
      'const a = value ?? "-";',
      'const key = `${ns ?? "-"}/${name}`;',
      'const parts = name.split("-");',
      "const Cell = () => <span>-</span>;",
      'const Ip = () => <Address fallback="-" />;',
    ].join("\n");
    expect(hyphenPlaceholders("x.tsx", source)).toEqual([
      "x.tsx:1",
      "x.tsx:4",
      "x.tsx:5",
    ]);
  });

  /** The scan itself: a Rust comment, lifetime or escape is skipped, a literal of any kind is not. */
  it("tells a dash in a Rust literal from one in a comment", () => {
    const source = [
      "/// a doc — fine",
      "/* outer /* nested — fine */ still — fine */",
      "fn f<'a>(x: &'a str) -> char { '\\u{2014}' }",
      'let a = "plain — caught";',
      'let b = r#"raw "quoted" – caught"#;',
      'let c = "escaped \\" quote — caught";',
      "let d = '—';",
      'let e = "two\nlines — caught";',
    ].join("\n");
    expect(dashedRustLiterals("x.rs", source)).toEqual([
      "x.rs:4",
      "x.rs:5",
      "x.rs:6",
      "x.rs:7",
      "x.rs:9",
    ]);
  });

  /** The scan itself: a dash in a comment is skipped, one in drawn text is not. */
  it("tells a dash in drawn text from one in a comment", () => {
    const source = [
      "// a comment — fine",
      "/** a doc — fine */",
      'const empty = "—";',
      "const Row = () => <p>a – b {/* note — fine */}</p>;",
    ].join("\n");
    expect(dashedLines("x.tsx", source)).toEqual(["x.tsx:3", "x.tsx:4"]);
  });
});
