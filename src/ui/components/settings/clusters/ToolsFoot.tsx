import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";

import { Spinner } from "@/components/ui/spinner";
import { commands } from "@/lib/commands";
import { queryKeys } from "@/lib/query-keys";
import { cn } from "@/lib/utils";
import { useDependenciesStore } from "@/stores/dependenciesStore";
import { useSettingSearchMatch } from "../settings-search";
import { useT, type T } from "@/i18n/useT";

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
  const { helm, kubectl, unread, ensureDependencies } = useDependenciesStore();
  const t = useT();

  useEffect(() => {
    void ensureDependencies();
  }, [ensureDependencies]);

  const { data: gcpProfiles } = useQuery({
    queryKey: queryKeys.gcpProfiles(),
    queryFn: commands.listGcpProfiles,
  });
  const { data: azureProfiles } = useQuery({
    queryKey: queryKeys.azureProfiles(),
    queryFn: commands.listAzureProfiles,
  });

  const visible = useSettingSearchMatch(
    t("settings", "searchToolsWords"),
    t("settings", "searchCloudWords"),
    kubectl?.version ?? "",
    helm?.version ?? ""
  );

  return (
    <p
      className={cn(
        "mt-3.5 max-w-[86ch] text-caption leading-[1.7] text-fg-fnt",
        !visible && "hidden"
      )}
      hidden={!visible}
    >
      <Tool
        name="kubectl"
        found={kubectl?.available}
        version={kubectl?.version}
        unread={unread.kubectl}
      />
      {" · "}
      <Tool
        name="helm"
        found={helm?.available}
        version={helm?.version}
        unread={unread.helm}
      />
      {" · "}
      <Foot onClick={onManagePaths} expanded={toolPathsOpen}>
        {t("settings", "manageToolPaths")}
      </Foot>
      {helm && !helm.available && `. ${t("settings", "helmOnlyForHelmPage")}`}
      <span className="px-2.5">·</span>
      <Foot onClick={onManageProfiles} expanded={profilesOpen}>
        {t("settings", "cloudProfiles")}
      </Foot>
      {profileSummary(gcpProfiles?.length, azureProfiles?.length, t)}
    </p>
  );
}

function Tool({
  name,
  found,
  version,
  unread,
}: {
  name: string;
  found: boolean | undefined;
  version: string | null | undefined;
  unread: string | null;
}) {
  const t = useT();
  return (
    <span>
      <span className="font-mono text-fg-mut">{name}</span>{" "}
      {unread !== null ? (
        <span className="text-warn" title={unread}>
          {t("settings", "notRead")}
        </span>
      ) : found === undefined ? (
        <Spinner
          size="xs"
          role="status"
          aria-label={t("action", "reading")}
          className="inline"
        />
      ) : found ? (
        (version ?? t("settings", "foundInline"))
      ) : (
        t("settings", "notFoundInline")
      )}
    </span>
  );
}

function profileSummary(
  gcp: number | undefined,
  azure: number | undefined,
  t: T
) {
  if (gcp === undefined || azure === undefined) return "";
  if (gcp === 0 && azure === 0) return t("settings", "toolsNoProfiles");
  return t("settings", "toolsProfiles", {
    gcp:
      gcp > 0
        ? t("settings", "toolsGcpCount", { n: gcp })
        : t("settings", "toolsNoGcp"),
    azure:
      azure > 0
        ? t("settings", "toolsAzureCount", { n: azure })
        : t("settings", "toolsNoAzure"),
  });
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
