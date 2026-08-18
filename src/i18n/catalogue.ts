/**
 * The English catalogue, which is also the type every other language is
 * checked against.
 *
 * `en` is a plain object rather than a JSON file so that TypeScript can do the
 * job an i18n library would otherwise do at runtime: `ru.ts` is declared
 * `Catalogue`, so a missing key is a compile error and a key nobody uses any
 * more is a dead-code warning. A library would have told us at runtime, on a
 * screen, in front of the reader.
 *
 * ## What never appears here
 *
 * Kubernetes vocabulary. Kind names, status values, condition types and
 * reasons, field names as the API spells them, and anything printed for parity
 * with `kubectl`. A reader who sees `CrashLoopBackOff` can search for it; a
 * reader who sees a translation of it cannot, and the diagnostics report they
 * paste into an issue would stop being readable by the maintainer. See
 * `src/lib/status-role.ts` for the mechanical half of that rule — the colour
 * lookup reads those strings.
 *
 * ## Plurals
 *
 * A count is not `${n} ${noun}${n === 1 ? "" : "s"}`. Russian has three forms
 * and Polish four, and the form depends on the number in a way English cannot
 * express. Anything counted is written as a `Plural` and resolved through
 * `Intl.PluralRules`, which knows every language's categories already.
 */

/** The forms a language may ask for. `other` is the only required one. */
export interface Plural {
  zero?: string;
  one?: string;
  two?: string;
  few?: string;
  many?: string;
  other: string;
}

export const en = {
  // The rail's own words. Resource rows are absent on purpose: their labels
  // come from `getDisplayPlural(kind)`, and a Kubernetes kind is a proper
  // noun that reads the same in every language — "Pods", not "Поды".
  nav: {
    overview: "Overview",
    workloads: "Workloads",
    cluster: "Cluster",
    network: "Network",
    storage: "Storage",
    config: "Config",
    integrations: "Integrations",
    app: "App",
    settings: "Settings",
  },
  /**
   * Table column headers.
   *
   * Only the ones that are UI words. A header naming a kind — Claim, Storage
   * Class, Volume — stays as the API spells it: the cell under it is a
   * reference to an object of that kind, and kubectl prints the same word.
   */
  columns: {
    name: "Name",
    namespace: "Namespace",
    age: "Age",
    memory: "Memory",
    capacity: "Capacity",
    accessModes: "Access Modes",
    replicas: "Replicas",
    keys: "Keys",
    status: "Status",
    ready: "Ready",
    restarts: "Restarts",
    node: "Node",
    strategy: "Strategy",
    desired: "Desired",
    current: "Current",
    completions: "Completions",
    schedule: "Schedule",
    suspend: "Suspend",
    active: "Active",
    lastSchedule: "Last Schedule",
    type: "Type",
    ports: "Ports",
    class: "Class",
    hosts: "Hosts",
    paths: "Paths",
    address: "Address",
    roles: "Roles",
    version: "Version",
    internalIp: "Internal IP",
    cpuUsage: "CPU Usage",
    memoryUsage: "Memory Usage",
    podCap: "Pod Cap",
    reclaimPolicy: "Reclaim Policy",
    bindingMode: "Binding Mode",
    expansion: "Expansion",
    parameters: "Parameters",
    delivery: "Delivery",
  },
  action: {
    cancel: "Cancel",
    close: "Close",
    save: "Save",
    delete: "Delete",
    retry: "Retry",
    refresh: "Refresh",
    copy: "Copy",
    copied: "Copied",
    manage: "Manage",
    openInBrowser: "Open in Browser",
    back: "Back",
  },
  activity: {
    title: "Activity",
    idle: "activity",
    ports: "Ports",
    terminals: "Terminals",
    jobs: "Jobs",
    portForwards: { one: "{n} port forward", other: "{n} port forwards" },
    terminalCount: { one: "{n} terminal", other: "{n} terminals" },
    jobCount: { one: "{n} job", other: "{n} jobs" },
    active: "{n} active",
  },
  cluster: {
    notConnected: "No cluster connected",
    connecting: "Connecting…",
    signInAgain: "Sign in again",
    podCount: { one: "{n} pod", other: "{n} pods" },
    problemCount: { one: "{n} problem", other: "{n} problems" },
  },
  settings: {
    language: "Language",
    languageHint:
      "The interface language. Kubernetes names and statuses stay as the cluster spells them.",
    systemLanguage: "Match the system",
  },
  empty: {
    nothingWrong: "Nothing here needs attention",
    noResults: "Nothing matched",
  },
} as const;

/**
 * The shape a translation must fill.
 *
 * Derived from `en` rather than declared beside it, so adding a key to English
 * is what makes every other language fail to compile — which is the only
 * moment anybody will remember to translate it.
 */
export type Catalogue = {
  [Section in keyof typeof en]: {
    [
      Key in keyof (typeof en)[Section]
    ]: (typeof en)[Section][Key] extends string ? string : Plural;
  };
};
