import { useThemeStore } from "@/stores/themeStore";
import { useUpdaterStore } from "@/stores/updaterStore";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Separator } from "@/components/ui/separator";
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
import {
  Download,
  RefreshCw,
  AlertCircle,
  Sun,
  Moon,
  Monitor,
} from "lucide-react";

export function Settings() {
  const { theme, setTheme } = useThemeStore();
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
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Settings</h1>
        <p className="text-muted-foreground">
          Customize your K8s GUI experience
        </p>
      </div>

      {/* Appearance */}
      <Card>
        <CardHeader>
          <CardTitle>Appearance</CardTitle>
          <CardDescription>
            Customize the look and feel of the application
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label>Theme</Label>
            <RadioGroup
              value={theme}
              onValueChange={(value) =>
                setTheme(value as "light" | "dark" | "system")
              }
              className="grid grid-cols-3 gap-4"
            >
              <div>
                <RadioGroupItem
                  value="light"
                  id="light"
                  className="peer sr-only"
                />
                <Label
                  htmlFor="light"
                  className="flex flex-col items-center justify-between rounded-md border-2 border-muted bg-popover p-4 hover:bg-accent hover:text-accent-foreground peer-data-[state=checked]:border-primary [&:has([data-state=checked])]:border-primary"
                >
                  <Sun className="mb-2 h-6 w-6" aria-hidden="true" />
                  Light
                </Label>
              </div>
              <div>
                <RadioGroupItem
                  value="dark"
                  id="dark"
                  className="peer sr-only"
                />
                <Label
                  htmlFor="dark"
                  className="flex flex-col items-center justify-between rounded-md border-2 border-muted bg-popover p-4 hover:bg-accent hover:text-accent-foreground peer-data-[state=checked]:border-primary [&:has([data-state=checked])]:border-primary"
                >
                  <Moon className="mb-2 h-6 w-6" aria-hidden="true" />
                  Dark
                </Label>
              </div>
              <div>
                <RadioGroupItem
                  value="system"
                  id="system"
                  className="peer sr-only"
                />
                <Label
                  htmlFor="system"
                  className="flex flex-col items-center justify-between rounded-md border-2 border-muted bg-popover p-4 hover:bg-accent hover:text-accent-foreground peer-data-[state=checked]:border-primary [&:has([data-state=checked])]:border-primary"
                >
                  <Monitor className="mb-2 h-6 w-6" aria-hidden="true" />
                  System
                </Label>
              </div>
            </RadioGroup>
          </div>
        </CardContent>
      </Card>

      {/* Kubeconfig */}
      <KubeconfigSettings />

      {/* Cloud Profiles */}
      <CloudProfiles />

      {/* CLI Tools */}
      <CliSettings />

      <RegistrySettings />

      <PortForwardManager />

      {/* About */}
      <Card>
        <CardHeader>
          <CardTitle>About</CardTitle>
          <CardDescription>Application information</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex justify-between">
            <span className="text-muted-foreground">Version</span>
            <span className="font-mono">{appInfo?.version ?? "..."}</span>
          </div>
          <Separator />
          <div className="flex justify-between">
            <span className="text-muted-foreground">Tauri</span>
            <span>{appInfo?.tauriVersion ?? "..."}</span>
          </div>
          <Separator />
          <div className="flex justify-between">
            <span className="text-muted-foreground">Framework</span>
            <span>React + TypeScript</span>
          </div>
          <Separator />

          {/* Update Section */}
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <div>
                <p className="font-medium">Updates</p>
                {updateAvailable && updateVersion && (
                  <p className="text-sm text-muted-foreground">
                    Version {updateVersion} available
                  </p>
                )}
                {updateError && (
                  <p className="text-sm text-destructive flex items-center gap-1">
                    <AlertCircle className="h-3 w-3" />
                    {updateError}
                  </p>
                )}
              </div>
              <div className="flex gap-2">
                {!updateAvailable && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={async () => {
                      const update = await checkForUpdates();
                      if (update) {
                        toast({
                          title: "Update available",
                          description: `Version ${update.version} is ready to download`,
                        });
                      } else if (!updateError) {
                        toast({
                          title: "No updates",
                          description: "You're running the latest version",
                        });
                      }
                    }}
                    disabled={updateChecking}
                  >
                    {updateChecking ? (
                      <>
                        <RefreshCw className="mr-2 h-4 w-4 animate-spin" />
                        Checking...
                      </>
                    ) : (
                      <>
                        <RefreshCw className="mr-2 h-4 w-4" />
                        Check for Updates
                      </>
                    )}
                  </Button>
                )}
                {updateAvailable && !updateDownloading && (
                  <Button
                    size="sm"
                    onClick={() => {
                      toast({
                        title: "Downloading update",
                        description:
                          "The app will restart automatically when ready",
                      });
                      downloadAndInstall();
                    }}
                  >
                    <Download className="mr-2 h-4 w-4" />
                    Download & Install
                  </Button>
                )}
              </div>
            </div>

            {updateDownloading && (
              <div className="space-y-2">
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">Downloading...</span>
                  <span className="font-mono">{updateProgress}%</span>
                </div>
                <Progress value={updateProgress} className="h-2" />
              </div>
            )}

            <Separator />

            {/* Auto-check toggle */}
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium">Automatic Updates</p>
                <p className="text-sm text-muted-foreground">
                  Check for updates on startup and every 30 minutes
                </p>
              </div>
              <Switch
                checked={autoCheckEnabled}
                onCheckedChange={setAutoCheckEnabled}
              />
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
