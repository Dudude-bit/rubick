import type { ReactNode } from "react";

import type { Diagnostics } from "@/generated/types";
import { T } from "@/i18n/T";

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
  const { searchPath, plugins, contexts, kubeconfig, app } = diagnostics;

  return (
    <div className="mt-6">
      <Block title={`Search path · ${searchPath.length} directories`}>
        <ul className="space-y-1">
          {searchPath.map((entry) => (
            <li key={entry.path} className="font-mono text-xs text-fg-mut">
              {entry.path}
              {!entry.exists && (
                <span className="ml-2 text-warn">not there</span>
              )}
            </li>
          ))}
        </ul>
      </Block>

      <Block title={`Plugins · ${plugins.length}`}>
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
                  <Missing label="not found" />
                )}
                <span className="ml-2">
                  · needed by {plugin.requiredBy.join(", ")}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Block>

      <Block title={`Contexts · ${contexts.length}`}>
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
                  <Missing label="not found" />
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
              <span className="ml-2">· {kubeconfig.contextCount} contexts</span>
            )}
          </p>
        ) : (
          <p className="text-xs text-fg-mut">
            None loaded yet — connect a cluster and this will name the file.
          </p>
        )}
      </Block>

      <Block title="Application">
        <ul className="space-y-1 text-xs text-fg-mut">
          <li>Version {app.version}</li>
          <li>{app.os}</li>
          {app.configPath && <li className="font-mono">{app.configPath}</li>}
          <li>Logs: {app.logDestination}</li>
        </ul>
      </Block>
    </div>
  );
}
