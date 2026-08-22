import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Monitor, Moon, Sun } from "lucide-react";

import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  useDisplaySettingsStore,
  type ResourceColouring,
} from "@/stores/displaySettingsStore";
import { useThemeStore } from "@/stores/themeStore";
import { useLocaleStore } from "@/stores/localeStore";
import { isTranslated, LOCALES, LOCALE_NAMES, type Locale } from "@/i18n";
import { useT } from "@/i18n/useT";
import { SettingRow, SettingsGroup } from "./settings-row";

const THEMES = [
  { value: "light", k: "themeLight", Icon: Sun },
  { value: "dark", k: "themeDark", Icon: Moon },
  { value: "system", k: "themeSystem", Icon: Monitor },
] as const;

const COLOURINGS = [
  { value: "full", k: "colouringFull", hintK: "colouringFullHint" },
  { value: "minimal", k: "colouringMinimal", hintK: "colouringMinimalHint" },
  { value: "off", k: "colouringOff", hintK: "colouringOffHint" },
] as const;

const SEGMENT =
  "flex h-6 cursor-pointer items-center gap-1.5 rounded px-1.5 text-[11px] font-normal text-fg-mut transition-colors hover:bg-hover peer-data-[state=checked]:bg-sel peer-data-[state=checked]:text-fg peer-focus-visible:ring-1 peer-focus-visible:ring-info";

export function AppearanceSettings() {
  const { theme, setTheme } = useThemeStore();
  const { resourceColouring, setResourceColouring } = useDisplaySettingsStore();
  const { choice, setChoice } = useLocaleStore();
  const t = useT();

  return (
    <SettingsGroup>
      <SettingRow
        label={t("settings", "language")}
        hint={t("settings", "languageHint")}
        htmlFor="setting-language"
        keywords="language locale translation русский"
        control={
          // A list, not the radio row the theme uses: six options and growing,
          // and a language is looked up by name rather than scanned. Each one
          // is written in itself — somebody who needs this setting cannot
          // necessarily read the current one.
          <Select
            value={choice ?? "system"}
            onValueChange={(value) =>
              setChoice(value === "system" ? null : (value as Locale))
            }
          >
            <SelectTrigger id="setting-language" className="h-7 w-56 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="system">
                {t("settings", "systemLanguage")}
              </SelectItem>
              {LOCALES.map((locale) => (
                <SelectItem key={locale} value={locale}>
                  {LOCALE_NAMES[locale]}
                  {/* Offered but empty: the scaffolding is done, the words are
                      not, and hiding it would hide where to contribute. */}
                  {isTranslated(locale)
                    ? ""
                    : ` — ${t("settings", "notTranslatedYet")}`}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        }
      />
      <SettingRow
        label={t("settings", "theme")}
        hint={t("settings", "themeHint")}
        keywords="dark light appearance"
        control={
          <RadioGroup
            value={theme}
            onValueChange={(value) =>
              setTheme(value as "light" | "dark" | "system")
            }
            className="flex items-center gap-0.5"
          >
            {THEMES.map(({ value, k, Icon }) => (
              <div key={value}>
                <RadioGroupItem
                  value={value}
                  id={`theme-${value}`}
                  className="peer sr-only"
                />
                <Label htmlFor={`theme-${value}`} className={SEGMENT}>
                  <Icon className="h-3 w-3" aria-hidden="true" />
                  {t("settings", k)}
                </Label>
              </div>
            ))}
          </RadioGroup>
        }
      />
      <SettingRow
        label={t("settings", "resourceColouring")}
        hint={t("settings", "resourceColouringHint")}
        // The app spells it the British way throughout; somebody who types
        // the other spelling is looking for exactly this row.
        keywords="color coloring tint kind"
        control={
          <RadioGroup
            value={resourceColouring}
            onValueChange={(value) =>
              setResourceColouring(value as ResourceColouring)
            }
            className="flex items-center gap-0.5"
          >
            {COLOURINGS.map(({ value, k, hintK }) => (
              <div key={value}>
                <RadioGroupItem
                  value={value}
                  id={`colouring-${value}`}
                  className="peer sr-only"
                />
                <Label
                  htmlFor={`colouring-${value}`}
                  title={t("settings", hintK)}
                  className={SEGMENT}
                >
                  {t("settings", k)}
                </Label>
              </div>
            ))}
          </RadioGroup>
        }
      />
    </SettingsGroup>
  );
}
