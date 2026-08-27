import * as React from "react";
import { useQuery } from "@tanstack/react-query";

import { commands } from "@/lib/commands";
import { useKubeconfigPath } from "@/hooks/useKubeconfigPath";
import { useClusterStore } from "@/stores/clusterStore";
import { BindingDialog } from "./clusters/BindingDialog";
import { CloudProfilesPanel } from "./clusters/CloudProfilesPanel";
import { ContextRow } from "./clusters/ContextRow";
import { SourceLine } from "./clusters/SourceLine";
import { ToolPathsPanel } from "./clusters/ToolPathsPanel";
import { ToolsFoot } from "./clusters/ToolsFoot";
import { execBinary } from "./clusters/context-reading";
import { useSettingSearchMatch } from "./settings-search";
import { T } from "@/i18n/T";
import { useT } from "@/i18n/useT";

/**
 * The contexts are the screen.
 *
 * The section promises "how the app reaches a cluster" and used to show
 * three blocks of configuration — a kubeconfig path, cloud profiles, CLI
 * paths — while never saying whether it could reach one. Those three are
 * not three topics. They are three reasons a context connects or does not,
 * so they are answers on the list rather than forms above it: the file is
 * one line, the profile is an adjective on the row that uses it, and the
 * binaries are a footnote with what depends on them.
 *
 * Everything here is read from disk and from PATH. No API server is
 * contacted, which is why "cannot connect" is always a statement about a
 * missing binary — reaching five clusters because somebody opened Settings
 * would be a surprise, and a slow one.
 */
export function ClustersSettings() {
  const [binding, setBinding] = React.useState<string | null>(null);
  const [toolPaths, setToolPaths] = React.useState(false);
  const [profiles, setProfiles] = React.useState(false);

  const currentContext = useClusterStore((state) => state.currentContext);
  const isConnected = useClusterStore((state) => state.isConnected);
  const t = useT();

  const { data: contexts, isLoading } = useQuery({
    queryKey: ["contexts"],
    queryFn: commands.listContexts,
  });
  const { data: bindings } = useQuery({
    queryKey: ["contextBindings"],
    queryFn: commands.listContextBindings,
  });

  // One lookup for the whole list: thirty contexts naming three distinct
  // plugins is three stat calls, not thirty.
  const wanted = React.useMemo(() => {
    const names = new Set<string>();
    for (const context of contexts ?? []) {
      const binary = execBinary(context.exec_command);
      if (context.auth.kind === "exec" && binary) names.add(binary);
    }
    return [...names].sort();
  }, [contexts]);

  const kubeconfig = useKubeconfigPath();

  const { data: located } = useQuery({
    queryKey: ["located-binaries", wanted],
    queryFn: () => commands.locateBinaries(wanted),
    enabled: wanted.length > 0,
  });

  const binaries = React.useMemo(
    () => new Map((located ?? []).map((one) => [one.name, one.path])),
    [located]
  );
  const bindingByContext = React.useMemo(
    () => new Map((bindings ?? []).map((one) => [one.contextName, one])),
    [bindings]
  );

  /**
   * Which file each context was read from, where more than one is being
   * read. Empty for a single file: every context came from it, and saying
   * so on every row is noise.
   */
  const fileOf = React.useMemo(() => {
    const files = kubeconfig.source?.candidates ?? [];
    const map = new Map<string, string>();
    if (files.length < 2) return map;
    for (const file of files) {
      for (const context of file.contexts) map.set(context, file.path);
    }
    return map;
  }, [kubeconfig.source]);

  // The current context first, then the file's own order. Somebody
  // arriving to check "the one I am on" should not scroll past twenty-nine
  // others to find it, and any cleverer sort would move rows under a
  // reader who had learned where they were.
  const ordered = React.useMemo(() => {
    const list = [...(contexts ?? [])];
    list.sort(
      (a, b) =>
        Number(b.name === currentContext) - Number(a.name === currentContext)
    );
    return list;
  }, [contexts, currentContext]);

  return (
    <div>
      <SourceLine />

      {isLoading ? (
        <p className="py-6 text-[11px] text-fg-fnt">
          {t("settings", "readingFile")}
        </p>
      ) : ordered.length === 0 ? (
        <NoContexts />
      ) : (
        <>
          <ListCaption count={ordered.length} />
          {ordered.map((context) => (
            <ContextRow
              key={context.name}
              context={context}
              binding={bindingByContext.get(context.name)}
              binaries={binaries}
              connected={isConnected && context.name === currentContext}
              onBind={setBinding}
              fromFile={fileOf.get(context.name)}
            />
          ))}
        </>
      )}

      <ToolsFoot
        toolPathsOpen={toolPaths}
        profilesOpen={profiles}
        onManagePaths={() => setToolPaths((open) => !open)}
        onManageProfiles={() => setProfiles((open) => !open)}
      />
      {toolPaths && <ToolPathsPanel />}
      {profiles && <CloudProfilesPanel />}

      <BindingDialog
        context={binding}
        onOpenChange={(open) => !open && setBinding(null)}
      />
    </div>
  );
}

/**
 * A long list needs a way through it, and the settings search is already
 * that way — every row indexes its name, its server, its plugin and its
 * profile. A second search field beside the first one would be two boxes
 * that do the same thing, so the caption points at the one that exists.
 */
function ListCaption({ count }: { count: number }) {
  const t = useT();
  return (
    <div className="flex items-baseline justify-between gap-4 pb-1 pt-3">
      <h3 className="text-[11px] font-semibold uppercase tracking-[0.07em] text-fg-fnt">
        {t("settings", "contexts")}
      </h3>
      {count > 8 && (
        <span className="text-[11px] text-fg-fnt">
          {t("settings", "searchFiltersList", { n: count })}
        </span>
      )}
    </div>
  );
}

function NoContexts() {
  const t = useT();
  const visible = useSettingSearchMatch(t("settings", "searchNoContextsWords"));
  return (
    <div className={visible ? "max-w-[64ch] py-8" : "hidden"} hidden={!visible}>
      <h3 className="text-xs font-medium text-fg">
        <T section="empty" k="fileNamesNoContexts" />
      </h3>
      <p className="mt-1.5 text-xs text-fg-mut">
        <T section="empty" k="fileNamesNoContextsBody" />
      </p>
    </div>
  );
}
