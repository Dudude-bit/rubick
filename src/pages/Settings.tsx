import { useThemeStore } from "@/stores/themeStore";
import { useUpdaterStore } from "@/stores/updaterStore";
import {
  useDisplaySettingsStore,
  type ResourceColouring,
} from "@/stores/displaySettingsStore";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Switch } from "@/components/ui/switch";
import { useQuery } from "@tanstack/react-query";
import { commands } from "@/lib/commands";
import { useToast } from "@/components/ui/use-toast";
import { PortForwardManager } from "@/components/port-forward/PortForwardManager";
import { RegistrySettings } from "@/components/registry/RegistrySettings";
import { CloudProfiles } from "@/components/settings/CloudProfiles";
import { CliSettings } from "@/components/settings/CliSettings";
import { KubeconfigSettings } from "@/components/settings/KubeconfigSettings";
import { SettingRow, SettingsGroup } from "@/components/settings/settings-row";
import {
  Download,
  RefreshCw,
  AlertCircle,
  Sun,
  Moon,
  Monitor,
} from "lucide-react";

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

export function Settings() {
  const { theme, setTheme } = useThemeStore();
  const { resourceColouring, setResourceColouring } = useDisplaySettingsStore();
  const { toast } = useToast();
  const {
    available: updateAvailable,
    version: updateVersion,
    checking: updateChecking,
    downloading: updateDownloading,
    progress: updateProgress,
    error: updateError,
    autoCheckEnabled,
    setAutoCheckEnabled,
    checkForUpdates,
    downloadAndInstall,
  } = useUpdaterStore();

  const { data: appInfo } = useQuery({
    queryKey: ["appInfo"],
    queryFn: commands.getAppInfo,
    staleTime: Infinity,
  });

  return (
    // No page title: the breadcrumb above already reads "Settings", and the
    // first group caption starts the content immediately.
    <div className="flex max-w-3xl flex-col gap-5 animate-in fade-in duration-200">
      <SettingsGroup title="Appearance">
        <SettingRow
          label="Theme"
          hint="System follows your desktop's light/dark preference."
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
                  <Label
                    htmlFor={`theme-${value}`}
                    className="flex h-6 cursor-pointer items-center gap-1.5 rounded px-1.5 text-[11px] font-normal text-fg-mut transition-colors hover:bg-hover peer-data-[state=checked]:bg-sel peer-data-[state=checked]:text-fg"
                  >
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
                    className="flex h-6 cursor-pointer items-center gap-1.5 rounded px-1.5 text-[11px] font-normal text-fg-mut transition-colors hover:bg-hover peer-data-[state=checked]:bg-sel peer-data-[state=checked]:text-fg"
                  >
                    {label}
                  </Label>
                </div>
              ))}
            </RadioGroup>
          }
        />
      </SettingsGroup>

      <KubeconfigSettings />
      <CloudProfiles />
      <CliSettings />
      <RegistrySettings />
      <PortForwardManager />

      <SettingsGroup title="About">
        <SettingRow
          label="Version"
          control={
            <span className="font-mono text-xs text-fg">
              {appInfo?.version ?? "…"}
            </span>
          }
        />
        <SettingRow
          label="Tauri"
          control={
            <span className="font-mono text-xs text-fg-mut">
              {appInfo?.tauriVersion ?? "…"}
            </span>
          }
        />
        <SettingRow
          label="Framework"
          control={
            <span className="text-xs text-fg-mut">React + TypeScript</span>
          }
        />
        <SettingRow
          label="Updates"
          hint={
            updateError ? (
              <span className="flex items-center gap-1 text-err">
                <AlertCircle className="h-3 w-3" aria-hidden="true" />
                {updateError}
              </span>
            ) : updateAvailable && updateVersion ? (
              `Version ${updateVersion} is available.`
            ) : (
              "You are running the latest version."
            )
          }
          control={
            updateAvailable && !updateDownloading ? (
              <Button
                size="sm"
                onClick={() => {
                  toast({
                    title: "Downloading update",
                    description: "The app restarts automatically when ready.",
                  });
                  downloadAndInstall();
                }}
              >
                <Download className="mr-1.5 h-3 w-3" aria-hidden="true" />
                Download &amp; install
              </Button>
            ) : (
              <Button
                variant="outline"
                size="sm"
                onClick={async () => {
                  const update = await checkForUpdates();
                  if (update) {
                    toast({
                      title: "Update available",
                      description: `Version ${update.version} is ready to download.`,
                    });
                  } else if (!updateError) {
                    toast({
                      title: "No updates",
                      description: "You're running the latest version.",
                    });
                  }
                }}
                disabled={updateChecking || updateDownloading}
              >
                <RefreshCw
                  className={`mr-1.5 h-3 w-3 ${updateChecking ? "animate-spin" : ""}`}
                  aria-hidden="true"
                />
                {updateChecking ? "Checking…" : "Check for updates"}
              </Button>
            )
          }
        >
          {updateDownloading && (
            <div className="flex items-center gap-2">
              <Progress value={updateProgress} className="max-w-xs" />
              <span className="font-mono text-[11px] text-fg-mut">
                {updateProgress}%
              </span>
            </div>
          )}
        </SettingRow>
        <SettingRow
          label="Automatic updates"
          hint="Check on startup and every 30 minutes."
          control={
            <Switch
              aria-label="Automatic updates"
              checked={autoCheckEnabled}
              onCheckedChange={setAutoCheckEnabled}
            />
          }
        />
      </SettingsGroup>
    </div>
  );
}
