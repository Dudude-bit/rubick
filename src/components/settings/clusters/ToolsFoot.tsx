import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";

import { commands } from "@/lib/commands";
import { cn } from "@/lib/utils";
import { useDependenciesStore } from "@/stores/dependenciesStore";
import { useSettingSearchMatch } from "../settings-search";

/**
 * The binaries, in one line, at the foot — with what depends on them.
 *
 * `helm not found` is not a warning here, because nothing on this screen
 * needs helm. It is a warning on the row whose auth needs a binary, and
 * only there. Same rule as the tab marks and the condition rows: a mark
 * only where it changes what you do.
 */
export function ToolsFoot({
  toolPathsOpen,
  profilesOpen,
  onManagePaths,
  onManageProfiles,
}: {
  toolPathsOpen: boolean;
  profilesOpen: boolean;
  onManagePaths: () => void;
  onManageProfiles: () => void;
}) {
  const { helm, kubectl, checkAllDependencies, isChecking } =
    useDependenciesStore();

  useEffect(() => {
    if ((helm === null || kubectl === null) && !isChecking) {
      void checkAllDependencies();
    }
  }, [helm, kubectl, isChecking, checkAllDependencies]);

  const { data: gcpProfiles } = useQuery({
    queryKey: ["gcpProfiles"],
    queryFn: commands.listGcpProfiles,
  });
  const { data: azureProfiles } = useQuery({
    queryKey: ["azureProfiles"],
    queryFn: commands.listAzureProfiles,
  });

  const visible = useSettingSearchMatch(
    "kubectl helm cli tools binary path version",
    "cloud profiles gcp google azure adc az login credentials",
    kubectl?.version ?? "",
    helm?.version ?? ""
  );

  return (
    <p
      className={cn(
        "mt-3.5 max-w-[86ch] text-[11px] leading-[1.7] text-fg-fnt",
        !visible && "hidden"
      )}
      hidden={!visible}
    >
      <Tool
        name="kubectl"
        found={kubectl?.available}
        version={kubectl?.version}
      />
      {" · "}
      <Tool name="helm" found={helm?.available} version={helm?.version} />
      {" — "}
      <Foot onClick={onManagePaths} expanded={toolPathsOpen}>
        manage tool paths
      </Foot>
      {helm &&
        !helm.available &&
        ". Helm is only needed for the Helm page; nothing here uses it."}
      <span className="px-2.5">·</span>
      <Foot onClick={onManageProfiles} expanded={profilesOpen}>
        Cloud profiles
      </Foot>
      {` ${profileSummary(gcpProfiles?.length, azureProfiles?.length)}`}
    </p>
  );
}

function Tool({
  name,
  found,
  version,
}: {
  name: string;
  found: boolean | undefined;
  version: string | null | undefined;
}) {
  return (
    <span>
      <span className="font-mono text-fg-mut">{name}</span>{" "}
      {found === undefined ? "…" : found ? (version ?? "found") : "not found"}
    </span>
  );
}

function profileSummary(gcp: number | undefined, azure: number | undefined) {
  if (gcp === undefined || azure === undefined) return "";
  if (gcp === 0 && azure === 0) return "— none defined.";
  return `— ${gcp > 0 ? `${gcp} GCP` : "none for GCP"}, ${
    azure > 0 ? `${azure} Azure` : "none for Azure"
  }.`;
}

function Foot({
  onClick,
  expanded,
  children,
}: {
  onClick: () => void;
  expanded: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-expanded={expanded}
      className="text-info hover:underline focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-info"
    >
      {children}
    </button>
  );
}
