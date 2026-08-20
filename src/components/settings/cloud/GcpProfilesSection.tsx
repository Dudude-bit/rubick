import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { open } from "@tauri-apps/plugin-dialog";
import { FolderOpen, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { ProfileRow, ProfileSection } from "./ProfileSection";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/components/ui/use-toast";
import type { GcpProfile } from "@/generated/types";
import { commands } from "@/lib/commands";
import { normalizeTauriError } from "@/lib/error-utils";
import { useT } from "@/i18n/useT";

const EMPTY_PROFILE: GcpProfile = {
  description: undefined,
  serviceAccountKeyPath: undefined,
  gcloudPath: undefined,
  defaultProject: undefined,
  preferNativeAuth: true,
};

export function GcpProfilesSection() {
  const t = useT();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingName, setEditingName] = useState<string | null>(null);
  const [editingProfile, setEditingProfile] =
    useState<GcpProfile>(EMPTY_PROFILE);
  const [newProfileName, setNewProfileName] = useState("");

  const { data: profiles, isLoading } = useQuery({
    queryKey: ["gcpProfiles"],
    queryFn: commands.listGcpProfiles,
  });

  const saveMutation = useMutation({
    mutationFn: async ({
      name,
      profile,
    }: {
      name: string;
      profile: GcpProfile;
    }) => {
      await commands.saveGcpProfile(name, profile);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["gcpProfiles"] });
      setDialogOpen(false);
      toast({ title: t("settings", "gcpProfileSaved") });
    },
    onError: (error) => {
      toast({
        title: t("action", "error"),
        description: normalizeTauriError(error),
        variant: "destructive",
      });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: commands.deleteGcpProfile,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["gcpProfiles"] });
      queryClient.invalidateQueries({ queryKey: ["contextBindings"] });
      toast({ title: t("settings", "gcpProfileDeleted") });
    },
    onError: (error) => {
      toast({
        title: t("action", "error"),
        description: normalizeTauriError(error),
        variant: "destructive",
      });
    },
  });

  const testMutation = useMutation({
    mutationFn: commands.testGcpProfile,
    onSuccess: (result) => {
      toast({
        title: result.includes("successful")
          ? t("settings", "success")
          : t("settings", "failed"),
        description: result,
        variant: result.includes("successful") ? "default" : "destructive",
      });
    },
  });

  const openEditDialog = (name: string, profile: GcpProfile) => {
    setEditingName(name);
    setNewProfileName(name);
    setEditingProfile(profile);
    setDialogOpen(true);
  };

  const openCreateDialog = () => {
    setEditingName(null);
    setNewProfileName("");
    setEditingProfile(EMPTY_PROFILE);
    setDialogOpen(true);
  };

  const handleFilePicker = async (
    field: "serviceAccountKeyPath" | "gcloudPath"
  ) => {
    const selected = await open({
      multiple: false,
      filters:
        field === "serviceAccountKeyPath"
          ? [{ name: "JSON", extensions: ["json"] }]
          : undefined,
    });
    if (selected) {
      setEditingProfile((prev) => ({ ...prev, [field]: selected }));
    }
  };

  return (
    <>
      <ProfileSection
        title="GCP"
        addLabel={t("settings", "addProfile")}
        onAdd={openCreateDialog}
        isLoading={isLoading}
        isEmpty={!profiles || profiles.length === 0}
        emptyMessage={t("empty", "noProfilesGcp")}
      >
        {profiles?.map((item) => (
          <ProfileRow
            key={item.name}
            name={item.name}
            detail={
              item.profile.serviceAccountKeyPath
                ? t("settings", "serviceAccount")
                : undefined
            }
            description={item.profile.description}
            onTest={() => testMutation.mutate(item.name)}
            onEdit={() => openEditDialog(item.name, item.profile)}
            onDelete={() => deleteMutation.mutate(item.name)}
            busy={testMutation.isPending || deleteMutation.isPending}
          />
        ))}
      </ProfileSection>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {editingName
                ? t("settings", "editGcpProfile")
                : t("settings", "createGcpProfile")}
            </DialogTitle>
            <DialogDescription>
              {t("settings", "gcpProfileDialogHint")}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label>{t("settings", "profileName")}</Label>
              <Input
                value={newProfileName}
                onChange={(e) => setNewProfileName(e.target.value)}
                placeholder={t("settings", "profileNamePlaceholder")}
                disabled={!!editingName}
              />
            </div>
            <div className="space-y-2">
              <Label>{t("settings", "descriptionOptional")}</Label>
              <Input
                value={editingProfile.description || ""}
                onChange={(e) =>
                  setEditingProfile((prev) => ({
                    ...prev,
                    description: e.target.value || undefined,
                  }))
                }
                placeholder={t("settings", "gcpDescriptionPlaceholder")}
              />
            </div>
            <div className="space-y-2">
              <Label>{t("settings", "serviceAccountKeyPath")}</Label>
              <div className="flex gap-2">
                <Input
                  value={editingProfile.serviceAccountKeyPath || ""}
                  onChange={(e) =>
                    setEditingProfile((prev) => ({
                      ...prev,
                      serviceAccountKeyPath: e.target.value || undefined,
                    }))
                  }
                  placeholder={t("settings", "adcPlaceholder")}
                />
                <Button
                  variant="outline"
                  size="icon"
                  aria-label={t("settings", "browseServiceAccountKey")}
                  onClick={() => handleFilePicker("serviceAccountKeyPath")}
                >
                  <FolderOpen className="h-3.5 w-3.5" />
                </Button>
              </div>
              <p className="text-[11px] text-fg-mut">
                {t("settings", "adcHint")}
              </p>
            </div>
            <div className="space-y-2">
              <Label>{t("settings", "defaultProject")}</Label>
              <Input
                value={editingProfile.defaultProject || ""}
                onChange={(e) =>
                  setEditingProfile((prev) => ({
                    ...prev,
                    defaultProject: e.target.value || undefined,
                  }))
                }
                placeholder={t("settings", "gcpProjectPlaceholder")}
              />
            </div>
            <div className="flex items-center justify-between">
              <Label>{t("settings", "preferNativeAuth")}</Label>
              <Switch
                checked={editingProfile.preferNativeAuth}
                onCheckedChange={(checked) =>
                  setEditingProfile((prev) => ({
                    ...prev,
                    preferNativeAuth: checked,
                  }))
                }
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>
              {t("action", "cancel")}
            </Button>
            <Button
              onClick={() =>
                saveMutation.mutate({
                  name: newProfileName,
                  profile: editingProfile,
                })
              }
              disabled={!newProfileName || saveMutation.isPending}
            >
              {saveMutation.isPending && (
                <Loader2 className="mr-1.5 h-3 w-3 animate-spin" />
              )}
              {t("action", "save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
