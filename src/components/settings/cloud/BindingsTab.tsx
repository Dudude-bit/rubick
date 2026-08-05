import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Plus, Trash2 } from "lucide-react";

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

const EMPTY_BINDING: ContextBinding = {
  gcpProfile: undefined,
  azureProfile: undefined,
};

export function BindingsTab() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [selectedContext, setSelectedContext] = useState<string>("");
  const [editingBinding, setEditingBinding] =
    useState<ContextBinding>(EMPTY_BINDING);

  const { data: contexts } = useQuery({
    queryKey: ["contexts"],
    queryFn: commands.listContexts,
  });

  const { data: bindings, isLoading } = useQuery({
    queryKey: ["contextBindings"],
    queryFn: commands.listContextBindings,
  });

  const { data: gcpProfiles } = useQuery({
    queryKey: ["gcpProfiles"],
    queryFn: commands.listGcpProfiles,
  });

  const { data: azureProfiles } = useQuery({
    queryKey: ["azureProfiles"],
    queryFn: commands.listAzureProfiles,
  });

  const saveMutation = useMutation({
    mutationFn: async ({
      context,
      binding,
    }: {
      context: string;
      binding: ContextBinding;
    }) => {
      await commands.saveContextBinding(context, binding);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["contextBindings"] });
      setDialogOpen(false);
      toast({ title: "Context binding saved" });
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
    mutationFn: commands.deleteContextBinding,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["contextBindings"] });
      toast({ title: "Context binding removed" });
    },
    onError: (error) => {
      toast({
        title: "Error",
        description: normalizeTauriError(error),
        variant: "destructive",
      });
    },
  });

  const openEditDialog = async (contextName: string) => {
    setSelectedContext(contextName);
    try {
      const existing = await commands.getContextBinding(contextName);
      setEditingBinding(existing);
    } catch {
      setEditingBinding(EMPTY_BINDING);
    }
    setDialogOpen(true);
  };

  const unboundContexts = contexts?.filter(
    (ctx) => !bindings?.some((b) => b.contextName === ctx.name)
  );

  return (
    <div className="py-2">
      <p className="pb-1 text-[11px] text-fg-mut">
        A context without a binding authenticates with Application Default
        Credentials.
      </p>

      {isLoading ? (
        <p className="py-2 text-[11px] text-fg-mut">Loading…</p>
      ) : (
        <div className="flex flex-col gap-3">
          {bindings && bindings.length > 0 && (
            <div>
              <h4 className="pb-1 text-[11px] font-semibold uppercase tracking-[0.07em] text-fg-fnt">
                Bound
              </h4>
              {bindings.map((item) => (
                <div
                  key={item.contextName}
                  className="flex items-center justify-between gap-4 rounded px-1 py-1 transition-colors hover:bg-hover"
                >
                  <span className="flex min-w-0 items-baseline gap-2">
                    <span className="truncate font-mono text-xs text-fg">
                      {item.contextName}
                    </span>
                    <span className="truncate text-[11px] text-fg-mut">
                      {[
                        item.gcpProfile && `GCP: ${item.gcpProfile}`,
                        item.azureProfile && `Azure: ${item.azureProfile}`,
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </span>
                  </span>
                  <span className="flex flex-none items-center gap-0.5">
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => openEditDialog(item.contextName)}
                    >
                      Edit
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      aria-label={`Remove binding for ${item.contextName}`}
                      onClick={() => deleteMutation.mutate(item.contextName)}
                      disabled={deleteMutation.isPending}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </span>
                </div>
              ))}
            </div>
          )}

          {unboundContexts && unboundContexts.length > 0 && (
            <div>
              <h4 className="pb-1 text-[11px] font-semibold uppercase tracking-[0.07em] text-fg-fnt">
                Using defaults
              </h4>
              {unboundContexts.map((ctx) => (
                <div
                  key={ctx.name}
                  className="flex items-center justify-between gap-4 rounded px-1 py-1 transition-colors hover:bg-hover"
                >
                  <span className="truncate font-mono text-xs text-fg-mut">
                    {ctx.name}
                  </span>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => openEditDialog(ctx.name)}
                  >
                    <Plus className="mr-1.5 h-3 w-3" aria-hidden="true" />
                    Bind
                  </Button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Configure Context Binding</DialogTitle>
            <DialogDescription>
              <span className="font-mono">{selectedContext}</span>
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label>GCP Profile</Label>
              <Select
                value={editingBinding.gcpProfile || "__none__"}
                onValueChange={(value) =>
                  setEditingBinding((prev) => ({
                    ...prev,
                    gcpProfile: value === "__none__" ? undefined : value,
                  }))
                }
              >
                <SelectTrigger>
                  <SelectValue placeholder="Use default (ADC)" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__">Use default (ADC)</SelectItem>
                  {gcpProfiles?.map((p) => (
                    <SelectItem key={p.name} value={p.name}>
                      {p.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Azure Profile</Label>
              <Select
                value={editingBinding.azureProfile || "__none__"}
                onValueChange={(value) =>
                  setEditingBinding((prev) => ({
                    ...prev,
                    azureProfile: value === "__none__" ? undefined : value,
                  }))
                }
              >
                <SelectTrigger>
                  <SelectValue placeholder="Use default (az login)" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__">
                    Use default (az login)
                  </SelectItem>
                  {azureProfiles?.map((p) => (
                    <SelectItem key={p.name} value={p.name}>
                      {p.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={() =>
                saveMutation.mutate({
                  context: selectedContext,
                  binding: editingBinding,
                })
              }
              disabled={saveMutation.isPending}
            >
              {saveMutation.isPending && (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              )}
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
