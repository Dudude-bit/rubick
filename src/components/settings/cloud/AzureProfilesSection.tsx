import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";

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
import type { AzureProfile } from "@/generated/types";
import { commands } from "@/lib/commands";
import { normalizeTauriError } from "@/lib/error-utils";

const EMPTY_PROFILE: AzureProfile = {
  description: undefined,
  azPath: undefined,
  kubeloginPath: undefined,
  defaultSubscription: undefined,
  tenantId: undefined,
  useCliFallback: false,
  preferNativeAuth: true,
};

export function AzureProfilesSection() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingName, setEditingName] = useState<string | null>(null);
  const [editingProfile, setEditingProfile] =
    useState<AzureProfile>(EMPTY_PROFILE);
  const [newProfileName, setNewProfileName] = useState("");

  const { data: profiles, isLoading } = useQuery({
    queryKey: ["azureProfiles"],
    queryFn: commands.listAzureProfiles,
  });

  const saveMutation = useMutation({
    mutationFn: async ({
      name,
      profile,
    }: {
      name: string;
      profile: AzureProfile;
    }) => {
      await commands.saveAzureProfile(name, profile);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["azureProfiles"] });
      setDialogOpen(false);
      toast({ title: "Azure profile saved" });
    },
    onError: (error) => {
      toast({
        title: "Error",
        description: normalizeTauriError(error),
        variant: "destructive",
      });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: commands.deleteAzureProfile,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["azureProfiles"] });
      queryClient.invalidateQueries({ queryKey: ["contextBindings"] });
      toast({ title: "Azure profile deleted" });
    },
    onError: (error) => {
      toast({
        title: "Error",
        description: normalizeTauriError(error),
        variant: "destructive",
      });
    },
  });

  const testMutation = useMutation({
    mutationFn: commands.testAzureProfile,
    onSuccess: (result) => {
      toast({
        title: result.includes("successful") ? "Success" : "Failed",
        description: result,
        variant: result.includes("successful") ? "default" : "destructive",
      });
    },
  });

  const openEditDialog = (name: string, profile: AzureProfile) => {
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

  return (
    <ProfileSection
      title="Azure"
      addLabel="Add profile"
      onAdd={openCreateDialog}
      isLoading={isLoading}
      isEmpty={!profiles || profiles.length === 0}
      emptyMessage="No profiles — using the default az login credentials."
    >
      {profiles?.map((item) => (
        <ProfileRow
          key={item.name}
          name={item.name}
          detail={
            item.profile.tenantId
              ? `tenant ${item.profile.tenantId.slice(0, 8)}…`
              : undefined
          }
          description={item.profile.description}
          onTest={() => testMutation.mutate(item.name)}
          onEdit={() => openEditDialog(item.name, item.profile)}
          onDelete={() => deleteMutation.mutate(item.name)}
          busy={testMutation.isPending || deleteMutation.isPending}
        />
      ))}

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {editingName ? "Edit Azure Profile" : "Create Azure Profile"}
            </DialogTitle>
            <DialogDescription>
              Configure authentication settings for AKS clusters
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label>Profile Name</Label>
              <Input
                value={newProfileName}
                onChange={(e) => setNewProfileName(e.target.value)}
                placeholder="e.g., production, personal"
                disabled={!!editingName}
              />
            </div>
            <div className="space-y-2">
              <Label>Description (optional)</Label>
              <Input
                value={editingProfile.description || ""}
                onChange={(e) =>
                  setEditingProfile((prev) => ({
                    ...prev,
                    description: e.target.value || undefined,
                  }))
                }
                placeholder="e.g., Production AKS clusters"
              />
            </div>
            <div className="space-y-2">
              <Label>Tenant ID (optional)</Label>
              <Input
                value={editingProfile.tenantId || ""}
                onChange={(e) =>
                  setEditingProfile((prev) => ({
                    ...prev,
                    tenantId: e.target.value || undefined,
                  }))
                }
                placeholder="Azure AD Tenant ID"
              />
            </div>
            <div className="space-y-2">
              <Label>Default Subscription (optional)</Label>
              <Input
                value={editingProfile.defaultSubscription || ""}
                onChange={(e) =>
                  setEditingProfile((prev) => ({
                    ...prev,
                    defaultSubscription: e.target.value || undefined,
                  }))
                }
                placeholder="Azure Subscription ID"
              />
            </div>
            <div className="flex items-center justify-between">
              <Label>Use CLI Fallback</Label>
              <Switch
                checked={editingProfile.useCliFallback}
                onCheckedChange={(checked) =>
                  setEditingProfile((prev) => ({
                    ...prev,
                    useCliFallback: checked,
                  }))
                }
              />
            </div>
            <div className="flex items-center justify-between">
              <Label>Prefer Native SDK Auth</Label>
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
              Cancel
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
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </ProfileSection>
  );
}
