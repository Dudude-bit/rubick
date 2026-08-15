import * as React from "react";
import { FileText, FolderOpen } from "lucide-react";

import { Input } from "@/components/ui/input";
import type { KubeconfigSource } from "@/generated/types";
import { useKubeconfigPath } from "@/hooks/useKubeconfigPath";
import { useSettingSearchMatch } from "../settings-search";
import { cn } from "@/lib/utils";

/**
 * The file every other line on this screen is downstream of, and how it
 * was found.
 *
 * "How it was found" is the half that used to be missing. `~/.kube/config`
 * alone does not tell you whether the app read it because `$KUBECONFIG`
 * pointed there, because nothing did, or because somebody pinned it here —
 * and those are three different knobs, only one of which is in this app.
 *
 * There is no Save button. The path applies when you leave the field and
 * it is checked on the way in: an unreadable file is rejected by the same
 * loader the rest of the app uses, so the result is the feedback. The
 * resolved value is the text; the field only appears when you ask for it.
 */
export function SourceLine() {
  const kubeconfig = useKubeconfigPath();
  const [editing, setEditing] = React.useState(false);
  const [typed, setTyped] = React.useState("");

  const source = kubeconfig.source;
  const primary = source?.candidates[0];
  const contexts = source?.counts?.contexts;
  const busy = kubeconfig.isPending;

  const provenance = describeProvenance(source);
  const visible = useSettingSearchMatch(
    primary?.path ?? "",
    provenance,
    "kubeconfig file source contexts $KUBECONFIG default lookup override"
  );

  /**
   * Leaving the field is the commit. The path is validated by the same
   * loader the app reads clusters with, so a typo comes back as a
   * rejection and nothing changes — and a path that took is undoable from
   * the toast `useKubeconfigPath` raises.
   */
  const apply = (path: string) => {
    const trimmed = path.trim();
    setEditing(false);
    setTyped("");
    if (!trimmed || trimmed === (kubeconfig.overridePath ?? "")) return;
    kubeconfig.setPath(trimmed);
  };

  return (
    <div
      className={cn(
        "flex flex-wrap items-baseline gap-x-2 gap-y-1 border-b border-hair pb-3",
        !visible && "hidden"
      )}
      hidden={!visible}
    >
      <FileText className="size-3 self-center text-fg-fnt" aria-hidden />
      {editing ? (
        <span className="flex flex-1 items-center gap-1.5">
          <Input
            autoFocus
            aria-label="Kubeconfig file"
            placeholder={primary?.path ?? "/path/to/kubeconfig"}
            value={typed}
            disabled={busy}
            // Pre-filled with the path in force so it can be corrected,
            // selected so it can be replaced. Typing after an unselected
            // path silently concatenates two absolute paths.
            onFocus={(event) => event.currentTarget.select()}
            onChange={(event) => setTyped(event.target.value)}
            onBlur={(event) => apply(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur();
              if (event.key === "Escape") {
                event.stopPropagation();
                setTyped("");
                setEditing(false);
              }
            }}
            className="h-6 font-mono text-[11px]"
          />
          <button
            type="button"
            aria-label="Browse for a kubeconfig file"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => {
              setEditing(false);
              void kubeconfig.choose();
            }}
            className="flex-none rounded p-1 text-fg-fnt transition-colors hover:text-fg focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-info"
          >
            <FolderOpen className="size-3.5" />
          </button>
        </span>
      ) : (
        <>
          <span className="font-mono text-xs text-fg-mid">
            {primary?.path ?? "no kubeconfig"}
          </span>
          <span className="text-[11px] text-fg-fnt">
            {contexts != null && (
              <>
                · {contexts} context{contexts === 1 ? "" : "s"}{" "}
              </>
            )}
            · {provenance}
          </span>
          {primary && !primary.exists && (
            <span className="text-[11px] text-err">this file is not there</span>
          )}
          {source?.error && (
            <span className="text-[11px] text-err">{source.error}</span>
          )}
          <span className="ml-auto flex items-baseline gap-3 text-[11px]">
            {kubeconfig.overridePath && (
              <button
                type="button"
                onClick={() => kubeconfig.clearPath()}
                disabled={busy}
                className="text-fg-mut transition-colors hover:text-fg focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-info"
              >
                Use the default lookup
              </button>
            )}
            <button
              type="button"
              onClick={() => {
                setTyped(kubeconfig.overridePath ?? "");
                setEditing(true);
              }}
              className="text-info hover:underline focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-info"
            >
              Use another file
            </button>
          </span>
        </>
      )}
    </div>
  );
}

/**
 * Why this file and not another one — the sentence that names the knob.
 *
 * `$KUBECONFIG` can list several files that kube merges, so a list of one
 * and a list of four have to read differently; the reader who set the
 * variable is the only person who can say which of the four is wrong.
 */
function describeProvenance(source: KubeconfigSource | undefined): string {
  if (!source || source.candidates.length === 0) return "nothing was found";
  const origin = source.candidates[0].origin;
  if (origin === "override") return "pinned here, in this app";
  if (origin === "env") {
    const extra = source.candidates.length - 1;
    return extra > 0
      ? `named by $KUBECONFIG, merged with ${extra} more file${extra === 1 ? "" : "s"}`
      : "named by $KUBECONFIG";
  }
  return "found by the default lookup, since $KUBECONFIG is unset";
}
