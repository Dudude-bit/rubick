import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { Button } from "@/components/ui/button";
import { Reading } from "@/components/ui/states";
import { Unknown } from "@/components/ui/unknown";
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
import { queryKeys } from "@/lib/query-keys";
import { useT } from "@/i18n/useT";
import { toastWriteError } from "@/lib/toast-error";

const NONE = "__none__";
const EMPTY: ContextBinding = {
  gcpProfile: undefined,
  azureProfile: undefined,
};

/**
 * Which profile one context uses, edited from the row that has the problem
 * rather than from a list of every binding.
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

  const gcpQuery = useQuery({
    queryKey: queryKeys.gcpProfiles(),
    queryFn: commands.listGcpProfiles,
    enabled: context !== null,
  });
  const azureQuery = useQuery({
    queryKey: queryKeys.azureProfiles(),
    queryFn: commands.listAzureProfiles,
    enabled: context !== null,
  });
  const existingQuery = useQuery({
    queryKey: queryKeys.contextBinding(context),
    queryFn: () => commands.getContextBinding(context ?? ""),
    enabled: context !== null,
  });
  const existing = existingQuery.data;

  const binding =
    edited && edited.for === context ? edited.value : (existing ?? EMPTY);
  const setBinding = (next: (prev: ContextBinding) => ContextBinding) =>
    setEdited({ for: context ?? "", value: next(binding) });

  const failed = (error: unknown) =>
    toastWriteError(t("action", "error"), error);

  const done = (title: string) => {
    queryClient.invalidateQueries({ queryKey: queryKeys.contextBindings() });
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
      query: gcpQuery,
      set: (value: string | undefined) =>
        setBinding((prev) => ({ ...prev, gcpProfile: value })),
    },
    {
      id: "azure",
      label: t("settings", "azureProfile"),
      fallback: t("settings", "useDefaultAzLogin"),
      value: binding.azureProfile,
      query: azureQuery,
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
          {existingQuery.isError ? (
            <Unknown
              question={t("settings", "bindingUnread")}
              error={existingQuery.error}
              onRetry={() => existingQuery.refetch()}
            />
          ) : existingQuery.isPending ? (
            <Reading>{t("action", "reading")}</Reading>
          ) : (
            clouds.map((cloud) => (
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
                    {cloud.query.data?.map((profile) => (
                      <SelectItem key={profile.name} value={profile.name}>
                        {profile.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {cloud.query.isError && (
                  <Unknown
                    question={t("settings", "profilesUnread")}
                    error={cloud.query.error}
                    onRetry={() => cloud.query.refetch()}
                  />
                )}
              </div>
            ))
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("action", "cancel")}
          </Button>
          <Button
            onClick={() => save.mutate()}
            pending={save.isPending}
            disabled={!existingQuery.isSuccess}
          >
            {t("action", "save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
