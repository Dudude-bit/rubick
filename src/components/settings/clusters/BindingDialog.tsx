import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/components/ui/use-toast";
import type { ContextBinding } from "@/generated/types";
import { commands } from "@/lib/commands";
import { normalizeTauriError } from "@/lib/error-utils";
import { useT } from "@/i18n/useT";

const NONE = "__none__";
const EMPTY: ContextBinding = {
  gcpProfile: undefined,
  azureProfile: undefined,
};

/**
 * Which profile one context uses.
 *
 * This was a tab listing every context twice — bound and unbound — beside
 * the profile editor, which is the wrong grouping: nobody reads bindings
 * as a set. They read one, on the row that has the problem. So the list is
 * gone and what is left is the edit itself, opened from that row.
 *
 * Clearing both selects removes the binding rather than storing an empty
 * one, so "no profile" has exactly one representation.
 */
export function BindingDialog({
  context,
  onOpenChange,
}: {
  /** The context being bound, or null when the dialog is closed. */
  context: string | null;
  onOpenChange: (open: boolean) => void;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const t = useT();
  // Held against the context it was typed for, so opening the dialog on a
  // different row shows that row's binding rather than the last one's.
  const [edited, setEdited] = useState<{
    for: string;
    value: ContextBinding;
  } | null>(null);

  const { data: gcpProfiles } = useQuery({
    queryKey: ["gcpProfiles"],
    queryFn: commands.listGcpProfiles,
    enabled: context !== null,
  });
  const { data: azureProfiles } = useQuery({
    queryKey: ["azureProfiles"],
    queryFn: commands.listAzureProfiles,
    enabled: context !== null,
  });
  const { data: existing } = useQuery({
    queryKey: ["contextBinding", context],
    queryFn: () => commands.getContextBinding(context ?? ""),
    enabled: context !== null,
  });

  const binding =
    edited && edited.for === context ? edited.value : (existing ?? EMPTY);
  const setBinding = (next: (prev: ContextBinding) => ContextBinding) =>
    setEdited({ for: context ?? "", value: next(binding) });

  const failed = (error: unknown) =>
    toast({
      title: t("action", "error"),
      description: normalizeTauriError(error),
      variant: "destructive",
    });

  const done = (title: string) => {
    queryClient.invalidateQueries({ queryKey: ["contextBindings"] });
    queryClient.invalidateQueries({ queryKey: ["contextBinding"] });
    onOpenChange(false);
    toast({ title });
  };

  const save = useMutation({
    mutationFn: async () => {
      if (!context) return;
      if (!binding.gcpProfile && !binding.azureProfile) {
        await commands.deleteContextBinding(context);
        return;
      }
      await commands.saveContextBinding(context, binding);
    },
    onSuccess: () =>
      done(
        binding.gcpProfile || binding.azureProfile
          ? t("settings", "bindingSaved")
          : t("settings", "bindingRemoved")
      ),
    onError: failed,
  });

  const clouds = [
    {
      id: "gcp",
      label: t("settings", "gcpProfile"),
      fallback: t("settings", "useAdc"),
      value: binding.gcpProfile,
      profiles: gcpProfiles,
      set: (value: string | undefined) =>
        setBinding((prev) => ({ ...prev, gcpProfile: value })),
    },
    {
      id: "azure",
      label: t("settings", "azureProfile"),
      fallback: t("settings", "useDefaultAzLogin"),
      value: binding.azureProfile,
      profiles: azureProfiles,
      set: (value: string | undefined) =>
        setBinding((prev) => ({ ...prev, azureProfile: value })),
    },
  ] as const;

  return (
    <Dialog open={context !== null} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("settings", "profileForContext")}</DialogTitle>
          <DialogDescription>
            <span className="font-mono">{context}</span>
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-2">
          {clouds.map((cloud) => (
            <div key={cloud.id} className="space-y-2">
              <Label>{cloud.label}</Label>
              <Select
                value={cloud.value || NONE}
                onValueChange={(value) =>
                  cloud.set(value === NONE ? undefined : value)
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>{cloud.fallback}</SelectItem>
                  {cloud.profiles?.map((profile) => (
                    <SelectItem key={profile.name} value={profile.name}>
                      {profile.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ))}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("action", "cancel")}
          </Button>
          <Button onClick={() => save.mutate()} disabled={save.isPending}>
            {save.isPending && (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            )}
            {t("action", "save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
