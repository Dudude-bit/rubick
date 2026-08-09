import { Navigate, Route, Routes } from "react-router-dom";

import { RegistrySettings } from "@/components/registry/RegistrySettings";
import { AboutSettings } from "@/components/settings/AboutSettings";
import { AppearanceSettings } from "@/components/settings/AppearanceSettings";
import { ClustersSettings } from "@/components/settings/ClustersSettings";
import { IntegrationsSettings } from "@/components/settings/IntegrationsSettings";
import { SettingsNav } from "@/components/settings/SettingsNav";
import { SettingsSearchable } from "@/components/settings/settings-row";
import {
  SettingsSearchProvider,
  SettingsSectionScope,
  useSettingsSearch,
} from "@/components/settings/settings-search";
import {
  DEFAULT_SETTINGS_SECTION,
  SETTINGS_SECTIONS,
} from "@/components/settings/settings-sections";
import { useClusterStore } from "@/stores/clusterStore";
import { cn } from "@/lib/utils";

/**
 * The nav does not fold, and the arithmetic is why.
 *
 * Three things share the width: the app's rail at 208, this page's own
 * padding at 32, the section nav at 184, and a pane that needs about 520
 * to still fit a path field with its browse button beside it. That puts
 * the fold at a 944px window — and the app's `minWidth` is 1024, so the
 * narrowest window anybody can drag to still leaves the pane 600px. A
 * strip layout here would be a branch that cannot run.
 */

function sectionContent(id: string, connected: boolean) {
  switch (id) {
    case "appearance":
      return <AppearanceSettings />;
    case "clusters":
      return <ClustersSettings />;
    case "integrations":
      return connected ? (
        <IntegrationsSettings />
      ) : (
        // An empty list and an unanswerable question look the same and
        // mean different things: one says the cluster has none of these,
        // the other that nothing was asked.
        <div className="max-w-[64ch] py-8">
          <h3 className="text-xs font-medium text-fg">No cluster connected</h3>
          <p className="mt-1.5 text-xs text-fg-mut">
            Connect a cluster and this will say what it has. Every extension
            here is detected by asking the API server for its CRDs, and there is
            no API server to ask.
          </p>
        </div>
      );
    case "registries":
      // Registries keeps its own editor, which is not built from rows —
      // so the section is indexed as one thing.
      return (
        <SettingsSearchable keywords="registry registries image pull credentials docker ecr gcr harbor basic bearer token username password">
          <RegistrySettings />
        </SettingsSearchable>
      );
    case "about":
      return <AboutSettings />;
    default:
      return null;
  }
}

function SettingsShell({ activeId }: { activeId: string }) {
  const { query, terms, counts } = useSettingsSearch();
  const currentContext = useClusterStore((state) => state.currentContext);
  const searching = terms.length > 0;

  const active =
    SETTINGS_SECTIONS.find((section) => section.id === activeId) ??
    SETTINGS_SECTIONS[0];
  const matched = counts[active.id] ?? 0;

  return (
    <div className="flex h-full min-h-0 flex-row">
      <SettingsNav activeId={active.id} />

      <div className="min-w-0 flex-1 overflow-auto scrollbar-thin pb-8 pl-5 pr-1 pt-1">
        {/* Capped, because a row 950px wide puts the control it belongs to
            at the other end of the screen from its label. */}
        <div className="max-w-3xl">
          <div className="flex items-baseline gap-2.5">
            <h1 className="text-[13px] font-semibold text-fg">
              {active.label}
            </h1>
            <span className="text-[11px] text-fg-fnt">
              {searching ? (
                matched === 0 ? (
                  <>nothing here matches &ldquo;{query}&rdquo;</>
                ) : (
                  <>
                    {matched} setting{matched === 1 ? "" : "s"} match
                    {matched === 1 ? "es" : ""} &ldquo;{query}&rdquo;
                  </>
                )
              ) : active.clusterScoped && currentContext ? (
                <>
                  in <span className="font-mono">{currentContext}</span>
                </>
              ) : null}
            </span>
          </div>
          <p className="mb-4 mt-0.5 max-w-[70ch] text-[11px] text-fg-fnt">
            {active.description}
          </p>

          {SETTINGS_SECTIONS.map((section) => {
            const isActive = section.id === active.id;
            // A search that only counted the section you are standing in
            // would dim the other four regardless of what they hold, so a
            // query is what mounts them. Nothing is fetched for a section
            // nobody has asked about until somebody starts typing.
            if (!isActive && !searching) return null;
            return (
              <div
                key={section.id}
                className={cn(!isActive && "hidden")}
                hidden={!isActive}
              >
                <SettingsSectionScope id={section.id}>
                  {sectionContent(section.id, Boolean(currentContext))}
                </SettingsSectionScope>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/**
 * Settings, as five sections rather than one scroll of eight groups.
 *
 * Every section is a URL, because a settings page you cannot link
 * somebody to is the one screen in the app that cannot be pointed at —
 * and three places already link here meaning a particular part of it.
 *
 * An unknown section redirects to the default instead of rendering the
 * blank shell an unmatched child route otherwise leaves behind. `replace`
 * keeps the typo out of the history so Back still goes back.
 */
export function Settings() {
  return (
    <SettingsSearchProvider>
      <Routes>
        <Route
          index
          element={<Navigate to={DEFAULT_SETTINGS_SECTION} replace />}
        />
        {SETTINGS_SECTIONS.map((section) => (
          <Route
            key={section.id}
            path={section.id}
            element={<SettingsShell activeId={section.id} />}
          />
        ))}
        <Route
          path="*"
          element={
            <Navigate to={`/settings/${DEFAULT_SETTINGS_SECTION}`} replace />
          }
        />
      </Routes>
    </SettingsSearchProvider>
  );
}
