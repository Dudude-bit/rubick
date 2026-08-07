import { useState } from "react";
import { FolderOpen, RotateCcw } from "lucide-react";

import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { SettingRow, SettingsGroup } from "./settings-row";
import { useKubeconfigPath } from "@/hooks/useKubeconfigPath";

/**
 * Lets the user override the kubeconfig path used by the app. By
 * default the backend reads `$KUBECONFIG` or `~/.kube/config` (same
 * as kubectl). Setting a path here pins the app to that file across
 * restarts and is the supported way to test against a synthetic
 * kubeconfig without touching `~/.kube/config`.
 *
 * The reading, writing and invalidation all live in `useKubeconfigPath`,
 * because the front door offers the same two actions and a second copy
 * of them would be a second idea of what "reload" means. What is local
 * here is the text field: this is the only surface that lets a path be
 * typed rather than picked.
 */
export function KubeconfigSettings() {
  const kubeconfig = useKubeconfigPath();
  const [typed, setTyped] = useState<string | null>(null);

  // Null means "showing what is saved"; the field only takes over once
  // the user has actually edited it, so a reload is reflected instead of
  // being pinned to whatever was on screen when the page mounted.
  const value = typed ?? kubeconfig.overridePath ?? "";
  const busy = kubeconfig.isPending || kubeconfig.isLoading;

  return (
    <SettingsGroup title="Kubeconfig">
      <SettingRow
        label="Custom kubeconfig path"
        htmlFor="kubeconfig-path"
        hint={
          kubeconfig.overridePath ? (
            <>
              Active:{" "}
              <span className="font-mono">{kubeconfig.overridePath}</span>
            </>
          ) : (
            "Using the default lookup ($KUBECONFIG, then ~/.kube/config)."
          )
        }
        control={
          <>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setTyped(null);
                kubeconfig.clearPath();
              }}
              disabled={busy || !kubeconfig.overridePath}
            >
              <RotateCcw className="mr-1.5 h-3 w-3" aria-hidden="true" />
              Reset
            </Button>
            <Button
              size="sm"
              onClick={() => {
                kubeconfig.setPath(value);
                setTyped(null);
              }}
              disabled={
                busy || value === (kubeconfig.overridePath ?? "") || !value
              }
            >
              {kubeconfig.isPending ? "Saving…" : "Save"}
            </Button>
          </>
        }
      >
        <div className="flex gap-1.5">
          <Input
            id="kubeconfig-path"
            placeholder="Leave empty to use the default lookup"
            value={value}
            onChange={(e) => setTyped(e.target.value)}
            disabled={busy}
            className="font-mono"
          />
          <Button
            variant="outline"
            size="icon"
            aria-label="Browse for a kubeconfig file"
            onClick={() => void kubeconfig.choose()}
            disabled={busy}
          >
            <FolderOpen className="h-3.5 w-3.5" />
          </Button>
        </div>
      </SettingRow>
    </SettingsGroup>
  );
}
