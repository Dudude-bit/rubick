import { Input } from "@/components/ui/input";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Switch } from "@/components/ui/switch";
import type { SearchEngine } from "@/lib/hints";
import { useHintSettingsStore } from "@/stores/hintSettingsStore";
import { useT } from "@/i18n/useT";

import { SettingRow, SettingsGroup } from "./settings-row";

const ENGINES: Array<{ id: SearchEngine; label: string; address: string }> = [
  { id: "google", label: "Google", address: "google.com/search?q=…" },
  { id: "duckduckgo", label: "DuckDuckGo", address: "duckduckgo.com/?q=…" },
];

export function HandoffSettings() {
  const t = useT();
  const settings = useHintSettingsStore();

  return (
    <SettingsGroup>
      <SettingRow
        label={t("settings", "searchEngine")}
        hint={t("settings", "searchEngineHint")}
        keywords={t("settings", "searchHandoffWords")}
      >
        <RadioGroup
          value={settings.engine}
          onValueChange={(value) => settings.setEngine(value as SearchEngine)}
          className="flex flex-col gap-1.5"
        >
          {[
            ...ENGINES,
            {
              id: "custom" as const,
              label: t("settings", "searchEngineCustom"),
              address: "",
            },
          ].map((engine) => (
            <label
              key={engine.id}
              className="flex cursor-pointer items-start gap-2 text-xs text-fg-mid"
            >
              <RadioGroupItem
                value={engine.id}
                id={`setting-engine-${engine.id}`}
                className="mt-0.5"
              />
              <span className="flex flex-col">
                <span>{engine.label}</span>
                {engine.address ? (
                  <span className="font-mono text-[11px] text-fg-fnt">
                    {engine.address}
                  </span>
                ) : null}
              </span>
            </label>
          ))}
        </RadioGroup>
        {settings.engine === "custom" ? (
          <Input
            aria-label={t("settings", "searchCustomUrl")}
            placeholder="https://search.example.com/?q={q}"
            value={settings.customUrl}
            onChange={(event) => settings.setCustomUrl(event.target.value)}
            className="mt-2 h-7 w-full max-w-md font-mono text-xs"
          />
        ) : null}
      </SettingRow>
      <SettingRow
        label={t("settings", "stripNames")}
        hint={t("settings", "stripNamesHint")}
        htmlFor="setting-strip-names"
        keywords={t("settings", "searchHandoffWords")}
        control={
          <Switch
            id="setting-strip-names"
            checked={settings.stripNames}
            onCheckedChange={settings.setStripNames}
          />
        }
      />
      <SettingRow
        label={t("settings", "handoffLogLines")}
        hint={t("settings", "handoffLogLinesHint")}
        htmlFor="setting-handoff-logs"
        keywords={t("settings", "searchHandoffWords")}
        control={
          <Switch
            id="setting-handoff-logs"
            checked={settings.includeLogLines}
            onCheckedChange={settings.setIncludeLogLines}
          />
        }
      />
      <SettingRow
        label={t("settings", "showMostLikely")}
        hint={t("settings", "showMostLikelyHint")}
        htmlFor="setting-most-likely"
        keywords={t("settings", "searchHandoffWords")}
        control={
          <Switch
            id="setting-most-likely"
            checked={settings.showPanel}
            onCheckedChange={settings.setShowPanel}
          />
        }
      />
    </SettingsGroup>
  );
}
