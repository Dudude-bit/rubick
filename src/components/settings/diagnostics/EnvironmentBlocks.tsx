import type { ReactNode } from "react";

import type { Diagnostics } from "@/generated/types";
import { T } from "@/i18n/T";
import { useT } from "@/i18n/useT";

function Block({ title, children }: { title: string; children: ReactNode }) {
  return (
    <details className="border-t border-hair py-3">
      <summary className="cursor-pointer text-xs font-medium text-fg">
        {title}
      </summary>
      <div className="mt-2">{children}</div>
    </details>
  );
}

/** The one mark that changes what a reader does: this is not where you think. */
function Missing({ label }: { label: string }) {
  return <span className="ml-2 text-err">{label}</span>;
}

/**
 * The environment, one block per question.
 *
 * Collapsed by default. Somebody who came for the findings should not have to
 * scroll past six lists to leave, and somebody who came for the lists knows
 * which one they want.
 */
export function EnvironmentBlocks({
  diagnostics,
}: {
  diagnostics: Diagnostics;
}) {
  const { searchPath, tools, plugins, contexts, kubeconfig, app } = diagnostics;
  const t = useT();

  return (
    <div className="mt-6">
      <Block title={t("settings", "searchPathBlock", { n: searchPath.length })}>
        <ul className="space-y-1">
          {searchPath.map((entry) => (
            <li key={entry.path} className="font-mono text-xs text-fg-mut">
              {entry.path}
              {!entry.exists && (
                <span className="ml-2 text-warn">
                  {t("settings", "notThere")}
                </span>
              )}
            </li>
          ))}
        </ul>
      </Block>

      <Block
        title={t("settings", "toolsBlock", {
          found: tools.filter((tool) => tool.path).length,
          total: tools.length,
        })}
      >
        <ul className="space-y-1">
          {tools.map((tool) => (
            <li key={tool.name} className="text-xs text-fg-mut">
              <span className="font-mono text-fg">{tool.name}</span>
              {tool.path ? (
                <span className="ml-2 font-mono">{tool.path}</span>
              ) : (
                // Muted, not red. Nothing here is required: somebody who never
                // touches Azure is not missing `az`, and painting six absent
                // cloud CLIs as faults would bury the one that matters.
                <span className="ml-2">
                  {t("settings", "notInstalledInline")}
                </span>
              )}
              {tool.version && (
                <span className="ml-2 font-mono text-fg">{tool.version}</span>
              )}
              {/* Present and silent is the state worth a colour: the file is
                  there, so nobody will think to install it, and whatever
                  wanted it will fail later saying something else. */}
              {tool.path && !tool.version && (
                <span className="ml-2 text-warn">
                  {t("settings", "answeredNothing")}
                </span>
              )}
            </li>
          ))}
        </ul>
      </Block>

      <Block title={t("settings", "pluginsBlock", { n: plugins.length })}>
        {plugins.length === 0 ? (
          <p className="text-xs text-fg-mut">
            <T section="empty" k="noContextNeedsPlugin" />
          </p>
        ) : (
          <ul className="space-y-1">
            {plugins.map((plugin) => (
              <li key={plugin.name} className="text-xs text-fg-mut">
                <span className="font-mono text-fg">{plugin.name}</span>
                {plugin.path ? (
                  <span className="ml-2 font-mono">{plugin.path}</span>
                ) : (
                  <Missing label={t("settings", "notFoundInline")} />
                )}
                <span className="ml-2">
                  {t("settings", "neededBy", {
                    list: plugin.requiredBy.join(", "),
                  })}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Block>

      <Block title={t("settings", "contextsBlock", { n: contexts.length })}>
        {contexts.length === 0 ? (
          <p className="text-xs text-fg-mut">
            <T section="empty" k="noneRead" />
          </p>
        ) : (
          <ul className="space-y-1">
            {contexts.map((ctx) => (
              <li key={ctx.context} className="text-xs text-fg-mut">
                <span className="font-mono text-fg">{ctx.context}</span>
                <span className="ml-2">{ctx.method}</span>
                {ctx.command && (
                  <span className="ml-2 font-mono">{ctx.command}</span>
                )}
                {ctx.command && !ctx.commandPath && (
                  <Missing label={t("settings", "notFoundInline")} />
                )}
              </li>
            ))}
          </ul>
        )}
      </Block>

      <Block title="Kubeconfig">
        {kubeconfig ? (
          <p className="font-mono text-xs text-fg-mut">
            {kubeconfig.path}
            {kubeconfig.parseError ? (
              <Missing label={kubeconfig.parseError} />
            ) : (
              <span className="ml-2">
                ·{" "}
                {t("settings", "contextCount", {
                  n: kubeconfig.contextCount,
                })}
              </span>
            )}
          </p>
        ) : (
          <p className="text-xs text-fg-mut">
            {t("settings", "noKubeconfigLoaded")}
          </p>
        )}
      </Block>

      <Block title={t("settings", "applicationBlock")}>
        <ul className="space-y-1 text-xs text-fg-mut">
          <li>{t("settings", "appVersion", { version: app.version })}</li>
          <li>{app.os}</li>
          {app.configPath && <li className="font-mono">{app.configPath}</li>}
          <li>
            {t("settings", "logsTo", { destination: app.logDestination })}
          </li>
        </ul>
      </Block>
    </div>
  );
}
