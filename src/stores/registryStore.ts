import { create } from "zustand";
import { commands } from "@/lib/commands";

export type RegistryProvider =
  "docker-hub" | "registry-v2" | "harbor" | "gcr" | "ecr";

export interface RegistryConfig {
  id: string;
  label: string;
  provider: RegistryProvider;
  baseUrl?: string;
  host?: string;
  project?: string;
  accountId?: string;
  region?: string;
  // Unified auth fields
  authType: "none" | "basic" | "bearer";
  username?: string;
  password?: string;
  token?: string;
}

export const DEFAULT_REGISTRIES: RegistryConfig[] = [
  {
    id: "docker-hub",
    label: "Docker Hub",
    provider: "docker-hub",
    authType: "none",
  },
];

const ensureRegistryUrl = (input: string) => {
  const trimmed = input.trim();
  if (!trimmed) {
    return "";
  }
  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed;
  }
  return `https://${trimmed}`;
};

interface RegistryState {
  registries: RegistryConfig[];
  selectedRegistryId: string;
  loading: boolean;
  setSelectedRegistryId: (id: string) => void;
  refreshRegistries: () => Promise<void>;
  addRegistry: (config: Omit<RegistryConfig, "id">) => Promise<RegistryConfig>;
  updateRegistry: (
    id: string,
    updates: Partial<RegistryConfig>
  ) => Promise<void>;
  removeRegistry: (id: string) => Promise<void>;
  ensureRegistryUrl: (input: string) => string;
}

export const useRegistryStore = create<RegistryState>((set, get) => ({
  registries: DEFAULT_REGISTRIES,
  selectedRegistryId: DEFAULT_REGISTRIES[0].id,
  loading: false,

  setSelectedRegistryId: (id) => {
    if (!get().registries.some((registry) => registry.id === id)) {
      return;
    }
    set({ selectedRegistryId: id });
  },

  refreshRegistries: async () => {
    set({ loading: true });
    try {
      const configs = await commands.listRegistryConfigs();
      const registries: RegistryConfig[] = configs.map((c) => ({
        id: c.id,
        label: c.label,
        provider: c.provider as RegistryProvider,
        baseUrl: c.baseUrl ?? undefined,
        host: c.host ?? undefined,
        project: c.project ?? undefined,
        accountId: c.accountId ?? undefined,
        region: c.region ?? undefined,
        authType: (c.authType ?? "none") as RegistryConfig["authType"],
        username: c.username ?? undefined,
        password: c.password ?? undefined,
        token: c.token ?? undefined,
      }));

      // Always ensure Docker Hub is present
      const hasDockerHub = registries.some((r) => r.id === "docker-hub");
      const allRegistries = hasDockerHub
        ? registries
        : [...DEFAULT_REGISTRIES, ...registries];

      set({ registries: allRegistries });
    } catch (error) {
      console.error("Failed to load registries:", error);
    } finally {
      set({ loading: false });
    }
  },

  addRegistry: async (config) => {
    const nextRegistry: RegistryConfig = {
      ...config,
      id: `custom-${crypto.randomUUID()}`,
    };

    await commands.saveRegistryConfig(nextRegistry.id, {
      id: nextRegistry.id,
      label: nextRegistry.label,
      provider: nextRegistry.provider,
      baseUrl: nextRegistry.baseUrl ?? undefined,
      host: nextRegistry.host ?? undefined,
      project: nextRegistry.project ?? undefined,
      accountId: nextRegistry.accountId ?? undefined,
      region: nextRegistry.region ?? undefined,
      authType: nextRegistry.authType,
      username: nextRegistry.username ?? undefined,
      password: nextRegistry.password ?? undefined,
      token: nextRegistry.token ?? undefined,
    });

    const registries = [...get().registries, nextRegistry];
    set({ registries, selectedRegistryId: nextRegistry.id });
    return nextRegistry;
  },

  updateRegistry: async (id, updates) => {
    const registry = get().registries.find((r) => r.id === id);
    if (!registry) return;

    const updated = { ...registry, ...updates };

    await commands.saveRegistryConfig(id, {
      id: updated.id,
      label: updated.label,
      provider: updated.provider,
      baseUrl: updated.baseUrl ?? undefined,
      host: updated.host ?? undefined,
      project: updated.project ?? undefined,
      accountId: updated.accountId ?? undefined,
      region: updated.region ?? undefined,
      authType: updated.authType,
      username: updated.username ?? undefined,
      password: updated.password ?? undefined,
      token: updated.token ?? undefined,
    });

    const registries = get().registries.map((r) => (r.id === id ? updated : r));
    set({ registries });
  },

  removeRegistry: async (id) => {
    if (id === "docker-hub") {
      return;
    }

    await commands.deleteRegistryConfig(id);

    const registries = get().registries.filter((r) => r.id !== id);
    const selectedRegistryId =
      get().selectedRegistryId === id
        ? (registries[0]?.id ?? "docker-hub")
        : get().selectedRegistryId;
    set({ registries, selectedRegistryId });
  },

  ensureRegistryUrl,
}));

// Initialize registries on store creation
if (typeof window !== "undefined") {
  const store = useRegistryStore.getState();
  store.refreshRegistries().catch(console.error);
}
