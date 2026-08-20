import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Section } from "@/components/ui/section";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/components/ui/use-toast";
import {
  DEFAULT_REGISTRIES,
  RegistryConfig,
  RegistryProvider,
  useRegistryStore,
} from "@/stores/registryStore";
import { commands } from "@/lib/commands";
import { normalizeTauriError } from "@/lib/error-utils";
import { useT } from "@/i18n/useT";

export function RegistrySettings() {
  const t = useT();
  const { toast } = useToast();
  const registries = useRegistryStore((state) => state.registries);
  const selectedRegistryId = useRegistryStore(
    (state) => state.selectedRegistryId
  );
  const setSelectedRegistryId = useRegistryStore(
    (state) => state.setSelectedRegistryId
  );
  const addRegistry = useRegistryStore((state) => state.addRegistry);
  const updateRegistry = useRegistryStore((state) => state.updateRegistry);
  const removeRegistry = useRegistryStore((state) => state.removeRegistry);
  const refreshRegistries = useRegistryStore(
    (state) => state.refreshRegistries
  );
  const ensureRegistryUrl = useRegistryStore(
    (state) => state.ensureRegistryUrl
  );

  const [showRegistryEditor, setShowRegistryEditor] = useState(false);
  const [newRegistryLabel, setNewRegistryLabel] = useState("");
  const [newRegistryUrl, setNewRegistryUrl] = useState("");
  const [newRegistryProvider, setNewRegistryProvider] =
    useState<RegistryProvider>("registry-v2");
  const [newRegistryHost, setNewRegistryHost] = useState("");
  const [newRegistryProject, setNewRegistryProject] = useState("");
  const [newRegistryAccountId, setNewRegistryAccountId] = useState("");
  const [newRegistryRegion, setNewRegistryRegion] = useState("");
  const [registryEditorError, setRegistryEditorError] = useState("");
  const [importing, setImporting] = useState(false);

  // Local auth state for editing (password/token aren't returned from backend)
  const [editPassword, setEditPassword] = useState("");
  const [editToken, setEditToken] = useState("");
  const [authStatusMessage, setAuthStatusMessage] = useState("");

  const selectedRegistry = useMemo(() => {
    return (
      registries.find((registry) => registry.id === selectedRegistryId) ??
      DEFAULT_REGISTRIES[0]
    );
  }, [registries, selectedRegistryId]);

  const handleRegistrySave = async () => {
    const labelValue = newRegistryLabel.trim();
    if (newRegistryProvider === "docker-hub") {
      setRegistryEditorError(t("settings", "dockerHubAlreadyAvailable"));
      return;
    }
    if (
      newRegistryProvider === "registry-v2" ||
      newRegistryProvider === "harbor"
    ) {
      const urlValue = newRegistryUrl.trim();
      if (!urlValue) {
        setRegistryEditorError(t("settings", "registryUrlRequired"));
        return;
      }
      const baseUrl = ensureRegistryUrl(urlValue);
      const nextRegistry: Omit<RegistryConfig, "id"> = {
        label: labelValue || urlValue,
        provider: newRegistryProvider,
        baseUrl,
        authType: "none",
      };
      if (newRegistryProvider === "harbor" && newRegistryProject.trim()) {
        nextRegistry.project = newRegistryProject.trim();
      }
      await addRegistry(nextRegistry);
      setShowRegistryEditor(false);
      setNewRegistryLabel("");
      setNewRegistryUrl("");
      setNewRegistryProject("");
      setRegistryEditorError("");
      return;
    }
    if (newRegistryProvider === "gcr") {
      const hostValue = newRegistryHost.trim() || "gcr.io";
      await addRegistry({
        label: labelValue || hostValue,
        provider: "gcr",
        host: hostValue,
        project: newRegistryProject.trim() || undefined,
        authType: "none",
      });
      setShowRegistryEditor(false);
      setNewRegistryLabel("");
      setNewRegistryHost("");
      setNewRegistryProject("");
      setRegistryEditorError("");
      return;
    }
    if (newRegistryProvider === "ecr") {
      const accountId = newRegistryAccountId.trim();
      const region = newRegistryRegion.trim();
      if (!accountId || !region) {
        setRegistryEditorError(t("settings", "ecrFieldsRequired"));
        return;
      }
      await addRegistry({
        label: labelValue || `${accountId}.dkr.ecr.${region}.amazonaws.com`,
        provider: "ecr",
        accountId,
        region,
        authType: "none",
      });
      setShowRegistryEditor(false);
      setNewRegistryLabel("");
      setNewRegistryAccountId("");
      setNewRegistryRegion("");
      setRegistryEditorError("");
    }
  };

  const handleRegistryCancel = () => {
    setShowRegistryEditor(false);
    setNewRegistryLabel("");
    setNewRegistryUrl("");
    setNewRegistryHost("");
    setNewRegistryProject("");
    setNewRegistryAccountId("");
    setNewRegistryRegion("");
    setNewRegistryProvider("registry-v2");
    setRegistryEditorError("");
  };

  const handleRegistryOpen = () => {
    setShowRegistryEditor(true);
    setNewRegistryProvider("registry-v2");
    setNewRegistryLabel("");
    setNewRegistryUrl("");
    setNewRegistryHost("");
    setNewRegistryProject("");
    setNewRegistryAccountId("");
    setNewRegistryRegion("");
    setRegistryEditorError("");
  };

  const normalizeHost = (value?: string) => {
    if (!value) {
      return "";
    }
    return value
      .trim()
      .replace(/^https?:\/\//i, "")
      .split("/")[0]
      .toLowerCase();
  };

  const handleImportDockerConfig = async () => {
    setImporting(true);
    const previousSelection = selectedRegistryId;
    try {
      const entries = await commands.importDockerConfig();
      if (!entries.length) {
        toast({
          title: t("settings", "dockerConfigImportTitle"),
          description: t("settings", "noRegistriesInDockerConfig"),
        });
        return;
      }

      let added = 0;
      let updated = 0;

      for (const entry of entries) {
        if (!entry.host) {
          continue;
        }
        const host = normalizeHost(entry.host);

        if (!entry.isDockerHub) {
          const current = useRegistryStore
            .getState()
            .registries.find(
              (registry) =>
                normalizeHost(registry.baseUrl ?? registry.host) === host
            );
          if (current) {
            // Update existing: update baseUrl and credentials
            await updateRegistry(current.id, {
              baseUrl: entry.baseUrl || current.baseUrl,
              authType:
                (entry.auth?.authType as RegistryConfig["authType"]) ??
                current.authType,
              username: entry.auth?.username ?? current.username,
              password: entry.auth?.password ?? current.password,
              token: entry.auth?.token ?? current.token,
            });
            updated += 1;
          } else {
            // Add new registry with credentials
            await addRegistry({
              label: entry.host,
              provider: "registry-v2",
              baseUrl: entry.baseUrl,
              authType:
                (entry.auth?.authType as RegistryConfig["authType"]) ?? "none",
              username: entry.auth?.username ?? undefined,
              password: entry.auth?.password ?? undefined,
              token: entry.auth?.token ?? undefined,
            });
            added += 1;
          }
        } else {
          // Docker Hub - update credentials on existing docker-hub registry
          if (entry.auth && entry.auth.authType !== "none") {
            await updateRegistry("docker-hub", {
              authType: entry.auth.authType as RegistryConfig["authType"],
              username: entry.auth.username ?? undefined,
              password: entry.auth.password ?? undefined,
              token: entry.auth.token ?? undefined,
            });
            updated += 1;
          }
        }
      }

      await refreshRegistries();

      toast({
        title: t("settings", "dockerConfigImported"),
        description: t("settings", "dockerConfigImportSummary", {
          added,
          updated,
        }),
      });
    } catch (error) {
      toast({
        title: t("settings", "importFailed"),
        description: normalizeTauriError(error),
        variant: "destructive",
      });
    } finally {
      setSelectedRegistryId(previousSelection);
      setImporting(false);
    }
  };

  const handleAuthSave = async () => {
    setAuthStatusMessage("");
    try {
      const updates: Partial<RegistryConfig> = {
        authType: selectedRegistry.authType,
        username: selectedRegistry.username,
      };

      // Only update password/token if they were changed
      if (selectedRegistry.authType === "basic" && editPassword) {
        updates.password = editPassword;
      }
      if (selectedRegistry.authType === "bearer" && editToken) {
        updates.token = editToken;
      }

      await updateRegistry(selectedRegistryId, updates);
      setEditPassword("");
      setEditToken("");
      setAuthStatusMessage(t("settings", "credentialsSaved"));
    } catch {
      setAuthStatusMessage(t("settings", "credentialsSaveFailed"));
    }
  };

  const handleAuthClear = async () => {
    setAuthStatusMessage("");
    try {
      await updateRegistry(selectedRegistryId, {
        authType: "none",
        username: undefined,
        password: undefined,
        token: undefined,
      });
      setEditPassword("");
      setEditToken("");
      setAuthStatusMessage(t("settings", "credentialsCleared"));
    } catch {
      setAuthStatusMessage(t("settings", "credentialsClearFailed"));
    }
  };

  return (
    // No header: the settings section this lives in already names it and
    // says what it is for, and two titles stacked read as two panels.
    <Section>
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-end gap-2">
          <div className="min-w-[220px] flex-1 space-y-1.5">
            <Label>{t("settings", "registryLabel")}</Label>
            <Select
              value={selectedRegistryId}
              onValueChange={setSelectedRegistryId}
            >
              <SelectTrigger>
                <SelectValue placeholder={t("settings", "selectRegistry")} />
              </SelectTrigger>
              <SelectContent>
                {registries.map((registry) => (
                  <SelectItem key={registry.id} value={registry.id}>
                    {registry.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Button type="button" variant="outline" onClick={handleRegistryOpen}>
            {t("action", "addRegistry")}
          </Button>
          <Button
            type="button"
            variant="ghost"
            onClick={() => removeRegistry(selectedRegistryId)}
            disabled={selectedRegistryId === "docker-hub"}
          >
            {t("action", "remove")}
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={handleImportDockerConfig}
            disabled={importing}
          >
            {importing
              ? t("settings", "importing")
              : t("settings", "importDockerConfig")}
          </Button>
        </div>

        <p className="text-xs text-fg-mut">
          {t("settings", "dockerConfigNote")}
        </p>

        {showRegistryEditor && (
          <div className="space-y-2 border-t border-hair pt-3">
            <div className="space-y-1">
              <Label className="text-xs text-fg-mut">
                {t("settings", "registryProvider")}
              </Label>
              <Select
                value={newRegistryProvider}
                onValueChange={(value) =>
                  setNewRegistryProvider(value as RegistryProvider)
                }
              >
                <SelectTrigger>
                  <SelectValue placeholder={t("settings", "selectProvider")} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="registry-v2">Registry V2</SelectItem>
                  <SelectItem value="harbor">Harbor</SelectItem>
                  <SelectItem value="gcr">Google Container Registry</SelectItem>
                  <SelectItem value="ecr">Amazon ECR</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label className="text-xs text-fg-mut">
                {t("settings", "displayName")}
              </Label>
              <Input
                placeholder={t("settings", "registryLabelPlaceholder")}
                value={newRegistryLabel}
                onChange={(event) => setNewRegistryLabel(event.target.value)}
              />
            </div>
            {(newRegistryProvider === "registry-v2" ||
              newRegistryProvider === "harbor") && (
              <div className="space-y-1">
                <Label className="text-xs text-fg-mut">
                  {t("settings", "registryUrl")}
                </Label>
                <Input
                  placeholder="registry.example.com"
                  value={newRegistryUrl}
                  onChange={(event) => setNewRegistryUrl(event.target.value)}
                />
              </div>
            )}
            {newRegistryProvider === "harbor" && (
              <div className="space-y-1">
                <Label className="text-xs text-fg-mut">
                  {t("settings", "projectOptional")}
                </Label>
                <Input
                  placeholder="project-name"
                  value={newRegistryProject}
                  onChange={(event) =>
                    setNewRegistryProject(event.target.value)
                  }
                />
              </div>
            )}
            {newRegistryProvider === "gcr" && (
              <>
                <div className="space-y-1">
                  <Label className="text-xs text-fg-mut">
                    {t("columns", "host")}
                  </Label>
                  <Input
                    placeholder="gcr.io"
                    value={newRegistryHost}
                    onChange={(event) => setNewRegistryHost(event.target.value)}
                  />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs text-fg-mut">
                    {t("settings", "projectOptional")}
                  </Label>
                  <Input
                    placeholder="my-gcp-project"
                    value={newRegistryProject}
                    onChange={(event) =>
                      setNewRegistryProject(event.target.value)
                    }
                  />
                </div>
              </>
            )}
            {newRegistryProvider === "ecr" && (
              <>
                <div className="space-y-1">
                  <Label className="text-xs text-fg-mut">
                    {t("settings", "accountId")}
                  </Label>
                  <Input
                    placeholder="123456789012"
                    value={newRegistryAccountId}
                    onChange={(event) =>
                      setNewRegistryAccountId(event.target.value)
                    }
                  />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs text-fg-mut">
                    {t("settings", "region")}
                  </Label>
                  <Input
                    placeholder="us-east-1"
                    value={newRegistryRegion}
                    onChange={(event) =>
                      setNewRegistryRegion(event.target.value)
                    }
                  />
                </div>
              </>
            )}
            {registryEditorError && (
              <p className="text-xs text-err">{registryEditorError}</p>
            )}
            <div className="flex items-center gap-2">
              <Button type="button" size="sm" onClick={handleRegistrySave}>
                {t("action", "save")}
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={handleRegistryCancel}
              >
                {t("action", "cancel")}
              </Button>
            </div>
          </div>
        )}

        {selectedRegistry.id !== "docker-hub" && (
          <div className="space-y-2 border-t border-hair pt-3">
            <div className="space-y-1">
              <Label className="text-xs text-fg-mut">
                {t("settings", "displayName")}
              </Label>
              <Input
                value={selectedRegistry.label}
                onChange={(event) =>
                  updateRegistry(selectedRegistry.id, {
                    label: event.target.value,
                  })
                }
              />
            </div>
            {(selectedRegistry.provider === "registry-v2" ||
              selectedRegistry.provider === "harbor") && (
              <div className="space-y-1">
                <Label className="text-xs text-fg-mut">
                  {t("settings", "registryUrl")}
                </Label>
                <Input
                  placeholder="registry.example.com"
                  value={selectedRegistry.baseUrl ?? ""}
                  onChange={(event) =>
                    updateRegistry(selectedRegistry.id, {
                      baseUrl: event.target.value,
                    })
                  }
                />
              </div>
            )}
            {selectedRegistry.provider === "harbor" && (
              <div className="space-y-1">
                <Label className="text-xs text-fg-mut">
                  {t("settings", "projectOptional")}
                </Label>
                <Input
                  placeholder="project-name"
                  value={selectedRegistry.project ?? ""}
                  onChange={(event) =>
                    updateRegistry(selectedRegistry.id, {
                      project: event.target.value,
                    })
                  }
                />
              </div>
            )}
            {selectedRegistry.provider === "gcr" && (
              <>
                <div className="space-y-1">
                  <Label className="text-xs text-fg-mut">
                    {t("columns", "host")}
                  </Label>
                  <Input
                    placeholder="gcr.io"
                    value={selectedRegistry.host ?? ""}
                    onChange={(event) =>
                      updateRegistry(selectedRegistry.id, {
                        host: event.target.value,
                      })
                    }
                  />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs text-fg-mut">
                    {t("settings", "projectOptional")}
                  </Label>
                  <Input
                    placeholder="my-gcp-project"
                    value={selectedRegistry.project ?? ""}
                    onChange={(event) =>
                      updateRegistry(selectedRegistry.id, {
                        project: event.target.value,
                      })
                    }
                  />
                </div>
              </>
            )}
            {selectedRegistry.provider === "ecr" && (
              <>
                <div className="space-y-1">
                  <Label className="text-xs text-fg-mut">
                    {t("settings", "accountId")}
                  </Label>
                  <Input
                    placeholder="123456789012"
                    value={selectedRegistry.accountId ?? ""}
                    onChange={(event) =>
                      updateRegistry(selectedRegistry.id, {
                        accountId: event.target.value,
                      })
                    }
                  />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs text-fg-mut">
                    {t("settings", "region")}
                  </Label>
                  <Input
                    placeholder="us-east-1"
                    value={selectedRegistry.region ?? ""}
                    onChange={(event) =>
                      updateRegistry(selectedRegistry.id, {
                        region: event.target.value,
                      })
                    }
                  />
                </div>
              </>
            )}
          </div>
        )}

        <div className="space-y-2 border-t border-hair pt-3">
          <div className="space-y-1">
            <Label className="text-xs text-fg-mut">
              {t("settings", "auth")}
            </Label>
            <Select
              value={selectedRegistry.authType}
              onValueChange={(nextValue) =>
                updateRegistry(selectedRegistryId, {
                  authType: nextValue as RegistryConfig["authType"],
                })
              }
            >
              <SelectTrigger>
                <SelectValue placeholder={t("settings", "selectAuth")} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">{t("empty", "none")}</SelectItem>
                <SelectItem value="basic">Basic</SelectItem>
                <SelectItem value="bearer">Bearer token</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {selectedRegistry.authType === "basic" && (
            <div className="grid gap-2 sm:grid-cols-2">
              <Input
                placeholder={t("settings", "username")}
                value={selectedRegistry.username ?? ""}
                onChange={(event) =>
                  updateRegistry(selectedRegistryId, {
                    username: event.target.value,
                  })
                }
              />
              <Input
                type="password"
                placeholder={t("settings", "password")}
                value={editPassword}
                onChange={(event) => setEditPassword(event.target.value)}
              />
            </div>
          )}
          {selectedRegistry.authType === "bearer" && (
            <Input
              type="password"
              placeholder={t("settings", "token")}
              value={editToken}
              onChange={(event) => setEditToken(event.target.value)}
            />
          )}
          {selectedRegistry.authType !== "none" &&
            (selectedRegistry.username ||
              selectedRegistry.authType === "bearer") && (
              <div className="text-xs text-fg-mut">
                {selectedRegistry.authType === "basic" &&
                selectedRegistry.username
                  ? t("settings", "savedAs", {
                      username: selectedRegistry.username,
                    })
                  : t("settings", "credentialsConfigured")}
              </div>
            )}
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              size="sm"
              onClick={handleAuthSave}
              disabled={selectedRegistry.authType === "none"}
            >
              {t("action", "saveCredentials")}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={handleAuthClear}
            >
              {t("action", "clear")}
            </Button>
          </div>
          {authStatusMessage && (
            <p className="text-xs text-fg-mut">{authStatusMessage}</p>
          )}
        </div>
      </div>
    </Section>
  );
}
