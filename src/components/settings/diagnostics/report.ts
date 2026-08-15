import type { Diagnostics } from "@/generated/types";

/**
 * The report as markdown, which is what a chat message or an issue takes.
 *
 * Findings first, for the same reason the panel puts them first: whoever
 * reads the paste should meet the conclusion before the evidence.
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
      : d.findings.map((f) => `- **${f.title}** — ${f.detail}`)),
    "",
    "### Search path",
    ...d.searchPath.map(
      (e) => `- \`${e.path}\`${e.exists ? "" : " — not there"}`
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
