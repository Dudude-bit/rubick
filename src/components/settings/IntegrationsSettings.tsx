import { useQuery } from "@tanstack/react-query";

import { SettingRow, SettingsGroup } from "@/components/settings/settings-row";
import { useIntegrations } from "@/integrations";
import { commands } from "@/lib/commands";

/**
 * The one screen allowed to name an extension.
 *
 * Everywhere else asks for a capability. Here the reader is asking a
 * different question — what does this cluster have — and the answer is a
 * list of names.
 *
 * No Connect button and no fields, because there is nothing to connect or
 * fill in: an in-cluster extension is detected, not configured. Its CRDs
 * exist in this cluster's API server or they do not.
 *
 * "Gives" is the row's whole job. A list of what is installed tells you
 * what you have; naming the power tells you what you get for it, which is
 * the only reason anybody reads this screen.
 */
export function IntegrationsSettings() {
  const { statuses, isPending, error } = useIntegrations();
  const { data: context } = useQuery({
    queryKey: ["currentContext"],
    queryFn: commands.getCurrentContext,
    staleTime: Infinity,
  });

  return (
    <SettingsGroup title={context ? `Extensions · ${context}` : "Extensions"}>
      {statuses.map(({ vendor, installed, version }) => (
        <SettingRow
          key={vendor.id}
          label={vendor.name}
          hint={
            installed ? `Gives ${vendor.gives}` : `Would give ${vendor.gives}`
          }
          control={
            <span
              className={`text-[11px] ${installed ? "text-ok" : "text-fg-fnt"}`}
            >
              {error
                ? "could not read the cluster's CRDs"
                : isPending
                  ? "looking…"
                  : installed
                    ? `detected${version ? ` · ${version}` : ""}`
                    : "not installed"}
            </span>
          }
        />
      ))}
    </SettingsGroup>
  );
}
