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
    confirm: "Confirm",
    processing: "Processing...",
    openActions: "Open actions",
    openFullPage: "Open full page",
    copyName: "Copy name",
    more: "More",
    moreActions: "More actions",
    goBack: "Go back",
    show: "Show",
    hide: "Hide",
    revealAll: "Reveal all",
    hideAll: "Hide all",
    copyAll: "Copy all",
    clearSearch: "Clear search",
    logs: "Logs",
    updateImage: "Update image",
    scale: "Scale",
    scaleAnyway: "Scale anyway",
    restart: "Restart",
    debug: "Debug",
    portForward: "Port forward",
    validate: "Validate",
    apply: "Apply",
    applyAnyway: "Apply anyway",
    formatYaml: "Format YAML",
    copyToClipboard: "Copy to Clipboard",
    resetToOriginal: "Reset to Original",
    toggleDiffView: "Toggle Diff View",
    history: "History",
    viewDetails: "View details",
    viewInstances: "View instances",
    viewHistory: "View History",
    remove: "Remove",
    rollBack: "Roll back",
    uninstall: "Uninstall",
    install: "Install",
    upgrade: "Upgrade",
    addRepository: "Add repository",
    updateAll: "Update all",
    backToReleases: "Back to releases",
    checkAgain: "Check again",
    copyUrl: "Copy URL",
    leave: "Leave",
    keepWaiting: "Keep Waiting",
    startDebug: "Start Debug",
    stop: "Stop",
    starting: "Starting...",
    startPortForward: "Start port-forward",
    saveChanges: "Save changes",
    savePortForward: "Save port forward",
    copyDiagnostics: "Copy diagnostics",
    downloadAndInstall: "Download & install",
    checkForUpdates: "Check for updates",
    checking: "Checking…",
    disconnect: "Disconnect",
    connect: "Connect",
    edit: "Edit",
    test: "Test",
    testing: "Testing…",
    addRegistry: "Add registry",
    saveCredentials: "Save credentials",
    clear: "Clear",
    deleteSelection: "Delete selection",
    clearCanvas: "Clear canvas",
    import: "Import",
    openYaml: "Open YAML",
    removeResource: "Remove Resource",
    copyLinesInView: "Copy the lines in view",
    downloadFullLog: "Download the full log",
    clearBuffered: "Clear what is buffered",
    reconnect: "Reconnect",
    showCurrentRun: "Show the current run",
    showFewer: "Show fewer",
    showAll: "Show all {n}",
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
    nothingHereMatches: "nothing here matches “{query}”",
    searchNoMatch: "nothing here matches “{query}”",
    searchSettings: "Search settings",
    clearSearch: "Clear search",
    settingsSections: "Settings sections",
    navMatching: "{label}, {n} matching",
    theme: "Theme",
    themeHint: "System follows your desktop's light/dark preference.",
    themeLight: "Light",
    themeDark: "Dark",
    themeSystem: "System",
    resourceColouring: "Resource colouring",
    resourceColouringHint:
      "Colour tells resource kinds apart and gives each object a stable tint. Minimal keeps the icon only.",
    colouringFull: "Full",
    colouringFullHint: "Kind and identifier both coloured",
    colouringMinimal: "Minimal",
    colouringMinimalHint: "Kind by icon, identifier dimmed",
    colouringOff: "Off",
    colouringOffHint: "No colour on resource names",
    notTranslatedYet: "not translated yet",
    version: "Version",
    framework: "Framework",
    updates: "Updates",
    updateAvailable: "Version {version} is available",
    upToDate: "You are running the latest version",
    updateHint: "Downloading an update restarts the app when it is ready.",
    downloadingUpdate: "Downloading update",
    downloadingUpdateHint: "The app restarts automatically when ready.",
    downloadAndInstall: "Download & install",
    updateFound: "Update available",
    updateReady: "Version {version} is ready to download.",
    noUpdates: "No updates",
    upToDateToast: "You're running the latest version.",
    checkingUpdates: "Checking…",
    checkForUpdates: "Check for updates",
    autoUpdates: "Automatic updates",
    autoUpdatesHint: "Check on startup and every 30 minutes.",
    diagnosticsCopied: "Diagnostics copied",
    copyDiagnostics: "Copy diagnostics",
    redactNamesAndPaths: "Redact names and paths",
    diagnosticsAllClear:
      "Nothing here needs attention. The environment below is what this app sees when it spawns a credential plugin — which is not always what your shell sees.",
    searchPathBlock: {
      one: "Search path · {n} directory",
      other: "Search path · {n} directories",
    },
    notThere: "not there",
    pluginsBlock: "Plugins · {n}",
    noPluginNeeded: "No context needs one.",
    notFoundInline: "not found",
    neededBy: "· needed by {list}",
    contextsBlock: "Contexts · {n}",
    noneRead: "None read.",
    contextCount: { one: "{n} context", other: "{n} contexts" },
    noKubeconfigLoaded:
      "None loaded yet — connect a cluster and this will name the file.",
    applicationBlock: "Application",
    appVersion: "Version {version}",
    logsTo: "Logs: {destination}",
    readingFile: "Reading the file…",
    contexts: "Contexts",
    searchFiltersList: "{n} — search filters this list",
    noContextsTitle: "This file names no contexts",
    noContextsBody:
      "The file above parsed, and it has nothing to connect to. Either it is not the kubeconfig you meant or its contexts were never written — point the app at another file to check.",
    kubeconfigFile: "Kubeconfig file",
    browseKubeconfig: "Browse for a kubeconfig file",
    noKubeconfig: "no kubeconfig",
    fileNotThere: "this file is not there",
    useDefaultLookup: "Use the default lookup",
    useAnotherFile: "Use another file",
    manageToolPaths: "manage tool paths",
    helmOnlyForHelmPage:
      "Helm is only needed for the Helm page; nothing here uses it.",
    cloudProfiles: "Cloud profiles",
    foundInline: "found",
    notFound: "Not found",
    checking: "Checking",
    available: "Available",
    vendorProfile: "{vendor} profile",
    binaryNotOnPath:
      "is not on the PATH this app sees, so connecting will fail. Install it, or put its directory on that PATH and restart the app.",
    toolPathsSaveFailed: "Could not save the tool paths",
    kubectlPathNote:
      "Its directory is added to PATH when the app runs a credential plugin, which is how kubectl plugins like oidc-login are found.",
    helmPathNote:
      "Only the Helm page uses it. Nothing about reaching a cluster does.",
    toolPathsIntro:
      "Where these binaries live, when they are somewhere the app does not look. Leave a field empty to search PATH again.",
    recheckTool: "Re-check {tool}",
    toolPathPlaceholder: "/path/to/{tool} — leave empty to auto-detect",
    browseForBinary: "Browse for the {tool} binary",
    selectBinaryTitle: "Select {tool} binary",
    cloudProfilesIntro:
      "Named credentials for GKE and AKS. A context with none of them authenticates the way its plugin does by default.",
    bindingSaved: "Context binding saved",
    bindingRemoved: "Context binding removed",
    gcpProfile: "GCP profile",
    azureProfile: "Azure profile",
    useAdc: "Use Application Default Credentials",
    useDefaultAzLogin: "Use the default az login",
    profileForContext: "Profile for this context",
    loading: "Loading…",
    edit: "Edit",
    testNamed: "Test {name}",
    deleteNamed: "Delete {name}",
    gcpProfileSaved: "GCP profile saved",
    gcpProfileDeleted: "GCP profile deleted",
    azureProfileSaved: "Azure profile saved",
    azureProfileDeleted: "Azure profile deleted",
    success: "Success",
    failed: "Failed",
    addProfile: "Add profile",
    noGcpProfiles: "No profiles — using Application Default Credentials.",
    noAzureProfiles: "No profiles — using the default az login credentials.",
    serviceAccount: "service account",
    tenantDetail: "tenant {id}…",
    editGcpProfile: "Edit GCP Profile",
    createGcpProfile: "Create GCP Profile",
    editAzureProfile: "Edit Azure Profile",
    createAzureProfile: "Create Azure Profile",
    gcpProfileDialogHint: "Configure authentication settings for GKE clusters",
    azureProfileDialogHint:
      "Configure authentication settings for AKS clusters",
    profileName: "Profile Name",
    profileNamePlaceholder: "e.g., production, personal",
    descriptionOptional: "Description (optional)",
    gcpDescriptionPlaceholder: "e.g., Production GKE clusters",
    azureDescriptionPlaceholder: "e.g., Production AKS clusters",
    serviceAccountKeyPath: "Service Account Key Path (optional)",
    adcPlaceholder: "Leave empty to use ADC",
    browseServiceAccountKey: "Browse for a service account key",
    adcHint: "If not set, uses Application Default Credentials (gcloud auth).",
    defaultProject: "Default Project (optional)",
    gcpProjectPlaceholder: "GCP Project ID",
    preferNativeAuth: "Prefer Native SDK Auth",
    tenantId: "Tenant ID (optional)",
    tenantIdPlaceholder: "Azure AD Tenant ID",
    defaultSubscription: "Default Subscription (optional)",
    subscriptionPlaceholder: "Azure Subscription ID",
    useCliFallback: "Use CLI Fallback",
    language: "Language",
    languageHint:
      "The interface language. Kubernetes names and statuses stay as the cluster spells them.",
    systemLanguage: "Match the system",
  },
  empty: {
    noPodsForJob: "No pods for this job",
    noEventsForClaim: "No events for this claim",
    none: "None",
    noLabels: "No labels",
    noAnnotations: "No annotations",
    noFinalizers: "No finalizers",
    noOwner: "Nothing owns this object — it was created directly.",
    noConditions: "No conditions reported",
    noEventsForObject: "No events for this object",
    noEventsUnprovisioned:
      "No events yet — no provisioner has picked this claim up.",
    nothingScheduled: "nothing scheduled",
    scaledToZero: "scaled to zero",
    noResourcesInScope: "No resources of this type in the current scope.",
    nothingMatches: "Nothing matches",
    noDataKeys: "No data keys",
    nothingBelongsToObject: "Nothing of this kind belongs to this object.",
    deploymentHasNoReplicaSets: "This Deployment has no ReplicaSets",
    cronJobNotRunYet: "This CronJob has not run yet",
    noPodsForWorkload: "No pods for this workload",
    kindHoldsNoKeys: "This {kind} holds no keys",
    kindHasNoPods: "This {kind} has no pods right now",
    revisionHasNoPods: "This revision has no pods right now",
    noPodsSuperseded: "No pods — revision {revision} took over from this one.",
    noPodsScaledToZero: "No pods — the Deployment is scaled to zero.",
    noConditionsReplicaSet:
      "This ReplicaSet has raised nothing — it only reports a condition when it cannot create a pod.",
    noSelectorDaemonSet: "No selector — this DaemonSet matches nothing",
    noSelectorService: "No selector — this service does not pick pods by label",
    noParameters: "No parameters — the provisioner uses its own defaults.",
    noLabelsOnNode:
      "No labels on this node — not even the kubernetes.io/* set kubelet registers, which usually means the object was not read.",
    noneInScope: "none in scope",
    nothingBroken: "nothing broken",
    nothingRunning: "nothing running",
    usageIdleNote:
      "Usage is summed from running pods, and metrics-server keeps nothing about a pod that has exited — so there is no line rather than a line at zero.",
    kindScaledToZero: "This {kind} is scaled to zero.",
    kindNoPodsRunning: "None of this {kind}'s pods is running.",
    daemonSetNoNodeMatches:
      "No node matches this DaemonSet, so it has placed no pods.",
    cronJobSuspended: "This CronJob is suspended, so no run will start.",
    cronJobNoRunInFlight: "No run of this CronJob is in flight.",
    jobFinished: "This Job has finished.",
    jobNoPodRunningFailed:
      "No pod of this Job is running, and the last one failed.",
    jobNoPodRunning: "No pod of this Job is running.",
    noPodsToReadLogs: "This deployment has no pods to read logs from.",
    podMountsNothing: "This pod mounts nothing of its own.",
    noContainersInSpec:
      "No containers in this spec — nothing to inspect, and nothing an image or a probe could be read from.",
    noEnvVarsMatchFilter: "No environment variables match the selected filter",
    nothingReadForService: "Nothing was read for this Service.",
    servicePublishesNothing:
      "This Service publishes no address at all — nothing reaches it.",
    noSchemaInfo: "No schema information available.",
    noContextNeedsPlugin: "No context needs one.",
    noneRead: "None read.",
    fileNamesNoContexts: "This file names no contexts",
    fileNamesNoContextsBody:
      "The file above parsed, and it has nothing to connect to. Either it is not the kubeconfig you meant or its contexts were never written — point the app at another file to check.",
    configHasNoClusters: "The config file has no clusters in it",
    configHasNoClustersSub:
      "It was read, but it lists no context to connect with.",
    notConnectedYet: "You are not connected to a cluster yet",
    noKubeconfigFound: "No cluster configuration was found on this machine.",
    noClusterIsConnected: "No cluster is connected",
    kindReadFromCluster:
      "{kind} are read from a cluster, and this window is not on one yet.",
    notOnClusterYet: "This window is not on a cluster yet.",
    kubeconfigListsNoClusters: "Your kubeconfig lists no clusters either.",
    noClusterMatchesNeedle:
      "No cluster in the kubeconfig answers to “{needle}”.",
    noMatchesYet:
      "No matches yet — {answered} of {total} clusters have answered.",
    nothingSearchedNoCluster:
      "Nothing has been searched: no cluster here is connected yet.",
    nothingMatchesOnSearched:
      "Nothing matches “{query}” on the {answered} of {total} clusters that were searched.",
    nothingMatchesQuery: "Nothing matches “{query}”.",
    noHelmHistory: "No history — Helm keeps none for this release.",
    nothingRoutesThroughController:
      "Nothing routes through this controller, so there is no shape to draw.",
    noIntegrationByName: "No integration by that name",
    noIntegrationByNameBody:
      "This app has no page for “{slug}”. The name may have changed, or the link may be from a newer version.",
    integrationNotInstalled: "{name} is not installed in this cluster",
    integrationNotInstalledBody:
      "Its custom resource definitions are not in this API server, so there is nothing for this page to read. Every extension is optional — the cluster works exactly as it does now.",
    integrationNotConnected: "{name} is not connected",
    integrationNotConnectedBody:
      "It installs nothing in a cluster, so there is nothing to detect — it works from an address you give this app, kept per cluster. Give it one and this page comes alive.",
    noProfilesGcp: "No profiles — using Application Default Credentials.",
    noProfilesAzure: "No profiles — using the default az login credentials.",
    noCrdsInCluster: "This cluster has no custom resource definitions.",
    crdNoInstances: "The CRD is installed, but no {kind} has been created yet.",
    crdNoInstancesInNamespace:
      "The CRD is installed, but no {kind} has been created in {namespace} yet.",
    nothingManagesSecret:
      "Nothing in this namespace manages this Secret, so it will not renew on its own — whoever put this certificate here replaces it.",
    nothingWrong: "Nothing here needs attention",
    noResults: "Nothing matched",
  },
  count: {
    keys: { one: "{n} key", other: "{n} keys" },
    items: { one: "{n} item", other: "{n} items" },
    fields: { one: "{n} field", other: "{n} fields" },
    settingsMatch: { one: "{n} setting matches", other: "{n} settings match" },
    volumes: { one: "{n} volume", other: "{n} volumes" },
    paths: { one: "{n} path", other: "{n} paths" },
    hosts: { one: "{n} host", other: "{n} hosts" },
    resources: { one: "{n} resource", other: "{n} resources" },
    releases: { one: "{n} release", other: "{n} releases" },
    contexts: { one: "{n} context", other: "{n} contexts" },
    apiGroups: { one: "{n} API group", other: "{n} API groups" },
    loadBalancers: { one: "{n} load balancer", other: "{n} load balancers" },
    queriesRefused: {
      one: "{n} query was refused",
      other: "{n} queries were refused",
    },
    failedPods: { one: "{n} failed pod", other: "{n} failed pods" },
    summedOverPods: {
      one: "summed over {n} pod",
      other: "summed over {n} pods",
    },
    replicasWanted: { one: "replica wanted", other: "replicas wanted" },
    completionsWanted: {
      one: "completion wanted",
      other: "completions wanted",
    },
    retryNoun: { one: "retry", other: "retries" },
    lineNoun: { one: "line", other: "lines" },
    errorNoun: { one: "error", other: "errors" },
    warningNoun: { one: "warning", other: "warnings" },
    inSliceCount: { one: "in {n} slice", other: "in {n} slices" },
    restartNoun: { one: "restart", other: "restarts" },
    ofTotal: "{n} of {total}",
    ofTotalReady: "{n} of {total} ready",
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
