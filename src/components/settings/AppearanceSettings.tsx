import { Monitor, Moon, Sun } from "lucide-react";

import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  useDisplaySettingsStore,
  type ResourceColouring,
} from "@/stores/displaySettingsStore";
import { useThemeStore } from "@/stores/themeStore";
import { SettingRow, SettingsGroup } from "./settings-row";

const THEMES = [
  { value: "light", label: "Light", Icon: Sun },
  { value: "dark", label: "Dark", Icon: Moon },
  { value: "system", label: "System", Icon: Monitor },
] as const;

const COLOURINGS = [
  { value: "full", label: "Full", hint: "Kind and identifier both coloured" },
  {
    value: "minimal",
    label: "Minimal",
    hint: "Kind by icon, identifier dimmed",
  },
  { value: "off", label: "Off", hint: "No colour on resource names" },
] as const;

const SEGMENT =
  "flex h-6 cursor-pointer items-center gap-1.5 rounded px-1.5 text-[11px] font-normal text-fg-mut transition-colors hover:bg-hover peer-data-[state=checked]:bg-sel peer-data-[state=checked]:text-fg peer-focus-visible:ring-1 peer-focus-visible:ring-info";

export function AppearanceSettings() {
  const { theme, setTheme } = useThemeStore();
  const { resourceColouring, setResourceColouring } = useDisplaySettingsStore();

  return (
    <SettingsGroup>
      <SettingRow
        label="Theme"
        hint="System follows your desktop's light/dark preference."
        keywords="dark light appearance"
        control={
          <RadioGroup
            value={theme}
            onValueChange={(value) =>
              setTheme(value as "light" | "dark" | "system")
            }
            className="flex items-center gap-0.5"
          >
            {THEMES.map(({ value, label, Icon }) => (
              <div key={value}>
                <RadioGroupItem
                  value={value}
                  id={`theme-${value}`}
                  className="peer sr-only"
                />
                <Label htmlFor={`theme-${value}`} className={SEGMENT}>
                  <Icon className="h-3 w-3" aria-hidden="true" />
                  {label}
                </Label>
              </div>
            ))}
          </RadioGroup>
        }
      />
      <SettingRow
        label="Resource colouring"
        hint="Colour tells resource kinds apart and gives each object a stable tint. Minimal keeps the icon only."
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
            {COLOURINGS.map(({ value, label, hint }) => (
              <div key={value}>
                <RadioGroupItem
                  value={value}
                  id={`colouring-${value}`}
                  className="peer sr-only"
                />
                <Label
                  htmlFor={`colouring-${value}`}
                  title={hint}
                  className={SEGMENT}
                >
                  {label}
                </Label>
              </div>
            ))}
          </RadioGroup>
        }
      />
    </SettingsGroup>
  );
}
