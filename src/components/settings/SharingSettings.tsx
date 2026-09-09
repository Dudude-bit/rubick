import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Plus, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/components/ui/use-toast";
import { commands } from "@/lib/commands";
import { normalizeTauriError } from "@/lib/error-utils";
import { targetColor } from "@/lib/share-targets";
import { useT } from "@/i18n/useT";
import type { ShareTargetInfo } from "@/generated/types";

import { SettingRow, SettingsGroup } from "./settings-row";

const TARGETS_KEY = ["share-targets"];

interface Draft {
  id: string | null;
  label: string;
  apiUrl: string;
  kind: string;
  public: boolean;
  apiKey: string;
  /** A stored key stays stored while the field is empty. */
  hasKey: boolean;
}

const BLANK: Draft = {
  id: null,
  label: "",
  apiUrl: "https://postplan.dev",
  kind: "postplan",
  public: true,
  apiKey: "",
  hasKey: false,
};

export function SharingSettings() {
  const t = useT();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<Draft | null>(null);

  const targets = useQuery({
    queryKey: TARGETS_KEY,
    queryFn: () => commands.listShareTargets(),
  });

  const failed = (title: string) => (error: unknown) =>
    toast({
      title,
      description: normalizeTauriError(error),
      variant: "destructive",
    });

  const saved = () => {
    void queryClient.invalidateQueries({ queryKey: TARGETS_KEY });
    setDraft(null);
  };

  const save = useMutation({
    mutationFn: (value: Draft) =>
      commands.saveShareTarget({
        id: value.id,
        label: value.label.trim() || value.apiUrl,
        apiUrl: value.apiUrl.trim(),
        kind: value.kind,
        public: value.public,
        // Empty means "keep whatever is stored", which is why it is not sent.
        apiKey: value.apiKey.trim() === "" ? null : value.apiKey.trim(),
      }),
    onSuccess: saved,
    onError: failed(t("share", "publishFailed")),
  });

  const remove = useMutation({
    mutationFn: (id: string) => commands.removeShareTarget(id),
    onSuccess: saved,
    onError: failed(t("share", "publishFailed")),
  });

  const verify = useMutation({
    mutationFn: (id: string) => commands.verifyShareTarget(id),
    onSuccess: (identity) =>
      toast({
        title: t("share", "verified", {
          account: identity.accountName ?? "?",
          key: identity.apiKeyName ?? "?",
        }),
      }),
    onError: failed(t("share", "verifyFailed")),
  });

  const importKey = useMutation({
    mutationFn: () => commands.importPostplanKey(),
    onSuccess: (key) => {
      if (!key) {
        toast({ title: t("share", "noPostplanKey") });
        return;
      }
      setDraft((previous) => ({ ...(previous ?? BLANK), apiKey: key }));
      toast({ title: t("share", "importedPostplan") });
    },
    onError: failed(t("share", "verifyFailed")),
  });

  return (
    <SettingsGroup>
      <SettingRow
        label={t("settings", "sectionSharing")}
        hint={t("settings", "sectionSharingHint")}
        keywords={t("settings", "sharingWords")}
      >
        <div className="flex flex-col gap-2">
          {(targets.data ?? []).length === 0 && !draft ? (
            <p className="text-[11px] text-fg-fnt">
              {t("share", "targetsEmpty")}
            </p>
          ) : null}
          {(targets.data ?? []).map((target) => (
            <TargetRow
              key={target.id}
              target={target}
              onEdit={() =>
                setDraft({
                  id: target.id,
                  label: target.label,
                  apiUrl: target.apiUrl,
                  kind: target.kind,
                  public: target.public,
                  apiKey: "",
                  hasKey: target.hasKey,
                })
              }
              onVerify={() => verify.mutate(target.id)}
              onRemove={() => remove.mutate(target.id)}
              verifying={verify.isPending}
            />
          ))}
          {draft ? (
            <div className="flex flex-col gap-2 rounded border border-hair p-2">
              <Input
                aria-label={t("share", "targetLabel")}
                placeholder={t("share", "targetLabel")}
                value={draft.label}
                onChange={(event) =>
                  setDraft({ ...draft, label: event.target.value })
                }
                className="h-7 text-xs"
              />
              <Input
                aria-label={t("share", "targetUrl")}
                placeholder="https://plans.example.com"
                value={draft.apiUrl}
                onChange={(event) =>
                  setDraft({ ...draft, apiUrl: event.target.value })
                }
                className="h-7 font-mono text-xs"
              />
              <div className="flex items-center gap-2">
                <Select
                  value={draft.kind}
                  onValueChange={(kind) => setDraft({ ...draft, kind })}
                >
                  <SelectTrigger
                    aria-label={t("share", "targetKind")}
                    className="h-7 w-40 text-xs"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="postplan">
                      {t("share", "targetKindPostplan")}
                    </SelectItem>
                    <SelectItem value="generic">
                      {t("share", "targetKindGeneric")}
                    </SelectItem>
                  </SelectContent>
                </Select>
                <label className="flex items-center gap-1.5 text-xs text-fg-mut">
                  <Switch
                    checked={draft.public}
                    onCheckedChange={(value) =>
                      setDraft({ ...draft, public: value })
                    }
                  />
                  {t("share", "targetPublic")}
                </label>
              </div>
              <p className="text-[11px] text-fg-fnt">
                {t("share", "targetPublicHint")}
              </p>
              <Input
                type="password"
                aria-label={t("share", "targetKey")}
                placeholder={
                  draft.hasKey
                    ? t("share", "targetKeyKept")
                    : t("share", "targetKey")
                }
                value={draft.apiKey}
                onChange={(event) =>
                  setDraft({ ...draft, apiKey: event.target.value })
                }
                className="h-7 font-mono text-xs"
              />
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  onClick={() => save.mutate(draft)}
                  disabled={save.isPending || draft.apiUrl.trim() === ""}
                >
                  {t("action", "save")}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => importKey.mutate()}
                  disabled={importKey.isPending}
                >
                  {t("share", "importPostplan")}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setDraft(null)}
                >
                  {t("action", "cancel")}
                </Button>
              </div>
            </div>
          ) : (
            <Button
              size="sm"
              variant="outline"
              className="self-start"
              onClick={() => setDraft(BLANK)}
            >
              <Plus aria-hidden="true" className="mr-1.5 h-3.5 w-3.5" />
              {t("share", "addTarget")}
            </Button>
          )}
        </div>
      </SettingRow>
    </SettingsGroup>
  );
}

function TargetRow({
  target,
  onEdit,
  onVerify,
  onRemove,
  verifying,
}: {
  target: ShareTargetInfo;
  onEdit: () => void;
  onVerify: () => void;
  onRemove: () => void;
  verifying: boolean;
}) {
  const t = useT();
  return (
    <div
      className="flex items-center gap-2 rounded border border-hair px-2 py-1.5 text-xs"
      data-testid="share-target"
    >
      <span
        aria-hidden="true"
        className="h-3 w-[3px] flex-none rounded-sm"
        style={{ background: targetColor(target) }}
      />
      <button
        type="button"
        onClick={onEdit}
        className="min-w-0 flex-1 text-left hover:underline"
      >
        <span className="text-fg">{target.label}</span>{" "}
        <span className="font-mono text-[11px] text-fg-fnt">{target.host}</span>
        {target.public ? (
          <span className="ml-1.5 text-[11px] text-err">
            {t("share", "targetPublic")}
          </span>
        ) : null}
        {!target.hasKey ? (
          <span className="ml-1.5 text-[11px] text-warn">
            {t("share", "targetNoKey")}
          </span>
        ) : null}
      </button>
      <Button
        size="sm"
        variant="outline"
        onClick={onVerify}
        disabled={!target.hasKey || verifying}
      >
        <Check aria-hidden="true" className="mr-1.5 h-3.5 w-3.5" />
        {t("share", "verify")}
      </Button>
      <Button
        size="sm"
        variant="outline"
        aria-label={t("share", "removeTarget")}
        onClick={onRemove}
      >
        <Trash2 aria-hidden="true" className="h-3.5 w-3.5" />
      </Button>
    </div>
  );
}
