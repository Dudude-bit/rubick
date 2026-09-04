import type { Diagnostics } from "@/generated/types";
import { english, shellEnvLine } from "./shell-env";

/**
 * The report as markdown, which is what a chat message or an issue takes.
 *
 * Findings first, for the same reason the panel puts them first: whoever
 * reads the paste should meet the conclusion before the evidence.
 *
 * **English, deliberately, and the only screen text in the app that is.**
 * This is written to be pasted into an issue, where the maintainers read
 * it; a bug report in a language they do not read helps nobody, and the
 * reader who copies it is not the reader who has to act on it. The panel
 * around it — every heading, every button — is translated as usual.
 */
export function asMarkdown(d: Diagnostics): string {
  return [
    "## Rubick diagnostics",
    "",
    `Version ${d.app.version} · ${d.app.os}`,
    "",
    "### Findings",
    ...(d.findings.length === 0
      ? ["Nothing needs attention."]
      : d.findings.map((f) =>
          // A finding carrying a shell outcome is worded from the catalogue,
          // the same entry the pane renders — so the paste and the screen
          // cannot say different things about one machine.
          f.shell
            ? `- **${english("settings", "shellFindingTitle")}** — ${shellEnvLine(
                f.shell
              )} ${english("settings", "shellFindingConsequence")}`
            : `- **${f.title}** — ${f.detail}`
        )),
    "",
    "### Shell",
    shellEnvLine(d.shell),
    "",
    "### Search path",
    ...d.searchPath.map(
      (e) => `- \`${e.path}\`${e.exists ? "" : " — not there"}`
    ),
    "",
    "### Tools",
    // The caveat first, for the same reason the screen puts it first: a
    // maintainer reading a pasted report cannot see the machine, and
    // "not installed" from a search path nobody filled in would send them
    // looking for a missing binary that is sitting on the reader's PATH.
    ...(d.searchPathIsReal
      ? []
      : [english("settings", "toolsPathIsGuess"), ""]),
    // The version too: half the reports that lead somewhere turn on which
    // kubectl answered, and "installed" alone has never settled that.
    ...d.tools.map((tool) =>
      tool.path
        ? `- \`${tool.name}\` — ${tool.path}${
            tool.version ? ` · ${tool.version}` : " · no version reported"
          }`
        : `- \`${tool.name}\` — not installed`
    ),
    "",
    "### Plugins",
    ...(d.plugins.length === 0
      ? ["No context needs one."]
      : d.plugins.map(
          (p) =>
            `- \`${p.name}\` — ${p.path ?? "not found"} · needed by ${p.requiredBy.join(", ")}`
        )),
    "",
    "### Contexts",
    ...(d.contexts.length === 0
      ? ["None read."]
      : d.contexts.map(
          (c) =>
            `- \`${c.context}\` — ${c.method}${
              c.command
                ? ` (\`${c.command}\`${c.commandPath ? "" : ", not found"})`
                : ""
            }`
        )),
    "",
    "### Kubeconfig",
    d.kubeconfig
      ? `\`${d.kubeconfig.path}\` — ${
          d.kubeconfig.parseError ?? `${d.kubeconfig.contextCount} contexts`
        }`
      : "None loaded.",
  ].join("\n");
}
