import { ClusterList } from "@/components/cluster/ClusterList";
import { Spinner } from "@/components/ui/spinner";
import { useKubeconfigPath } from "@/hooks/useKubeconfigPath";
import { useRealtimeAge } from "@/hooks/useRealtimeAge";
import { useClusterStore } from "@/stores/clusterStore";
import { verbatim } from "@/lib/error-utils";
import { cn } from "@/lib/utils";
import type { KubeconfigSource } from "@/generated/types";
import { useT } from "@/i18n/useT";

/**
 * The first screen anyone sees.
 *
 * It used to greet the reader and send them to look for a control, which
 * is the one thing this screen cannot afford to do: the app has already
 * read the kubeconfig and knows exactly which clusters exist, so the
 * honest version of the screen is that list.
 *
 * Two people open it — someone who has never typed `kubectl`, and an SRE
 * who wants the path and the server's verbatim error. Splitting the
 * difference patronises one and fails the other, so every state here is
 * layered the way the pod pages already are: a plain sentence on top, the
 * machine's own words in mono underneath, both always present. The novice
 * stops after line two; the SRE reads line four first.
 *
 * Nothing below is written unless the backend actually said it. Where a
 * fact is not available the line is absent rather than plausible.
 */
export function ClusterFrontDoor() {
  const contexts = useClusterStore((s) => s.contexts);
  const isAuthenticating = useClusterStore((s) => s.isAuthenticating);
  const pendingContext = useClusterStore((s) => s.pendingContext);
  const connectStartedAt = useClusterStore((s) => s.connectStartedAt);
  const isLoading = useClusterStore((s) => s.isLoading);
  const error = useClusterStore((s) => s.error);
  const errorContext = useClusterStore((s) => s.errorContext);
  const connect = useClusterStore((s) => s.connect);
  const disconnect = useClusterStore((s) => s.disconnect);

  const kubeconfig = useKubeconfigPath();

  if (isAuthenticating && pendingContext) {
    return (
      <Door>
        <Connecting
          context={pendingContext}
          startedAt={connectStartedAt}
          onCancel={() => disconnect()}
        />
      </Door>
    );
  }

  if (error && errorContext) {
    return (
      <Door>
        <Failed
          context={errorContext}
          message={error}
          onRetry={() => connect(errorContext)}
        />
        <div className="mt-7">
          <ClusterList onSelect={connect} failedContext={errorContext} />
        </div>
        <SourceLine kubeconfig={kubeconfig} />
      </Door>
    );
  }

  // Initialising: the kubeconfig is being read and the saved cluster is a
  // beat from auto-connecting. A static screen here reads as "nothing is
  // happening", which is the opposite of what is true.
  if (contexts.length === 0 && isLoading) {
    return (
      <Door>
        <div className="flex items-center gap-2.5 text-xs text-fg-mut">
          <Spinner size="sm" aria-hidden />
          Reading your kubeconfig…
        </div>
      </Door>
    );
  }

  if (contexts.length === 0) {
    return (
      <Door>
        <NoClusters kubeconfig={kubeconfig} />
      </Door>
    );
  }

  return (
    <Door>
      <Heading
        title="Connect a cluster"
        sub={`${count(contexts.length, "context")} in your kubeconfig. Pick one to start.`}
      />
      <div className="mt-5">
        <ClusterList onSelect={connect} />
      </div>
      <SourceLine kubeconfig={kubeconfig} />
    </Door>
  );
}

/**
 * The column this screen is, and where it sits.
 *
 * Centred across the window, because a screen whose only job is one short
 * list has nothing to justify pinning it to a corner of a 1600px canvas.
 *
 * Down the page it is not centred but offset from the top, and that is the
 * part worth arguing. This block grows: one context is four lines, fifteen
 * is a full page. Centring would slide the heading upward with every
 * cluster added, so the same screen would meet two people in two different
 * places. A fixed offset keeps "Connect a cluster" where it was last time,
 * and lets the list grow downward into the room below it — which is the
 * direction a list grows anyway.
 *
 * The offset is a fraction of the window rather than a constant so it stays
 * a proportion on a laptop and on a monitor, and it is clamped at both ends
 * so a short window does not lose the heading off the top and a tall one
 * does not strand it in the middle.
 */
function Door({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full justify-center">
      <div className="w-full max-w-[560px] pb-10 pt-[clamp(2rem,16vh,10rem)] animate-in fade-in duration-200">
        {children}
      </div>
    </div>
  );
}

function Heading({ title, sub }: { title: string; sub?: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-[3px]">
      <h1 className="text-[13px] font-semibold tracking-tight text-fg">
        {title}
      </h1>
      {sub && <p className="text-xs text-fg-mut">{sub}</p>}
    </div>
  );
}

/**
 * The second layer: what the machine did, in its own words. Kept in mono
 * and at the faintest contrast the theme has, so it is skipped by a
 * reader who does not want it and found instantly by one who does.
 */
function Machine({
  children,
  tone,
}: {
  children: React.ReactNode;
  tone?: "error";
}) {
  return (
    <p
      className={cn(
        "mt-1 flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-[11px]",
        tone === "error" ? "text-err" : "text-fg-fnt"
      )}
    >
      {children}
    </p>
  );
}

const Mono = ({ children }: { children: React.ReactNode }) => (
  <span className="break-all font-mono">{children}</span>
);

/** A word to click that is not a button, because it is not the point of
 *  the screen it sits on. */
function Act({
  children,
  onClick,
  disabled,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="rounded-sm text-fg-mut underline decoration-dotted underline-offset-2 transition-colors hover:text-fg focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-info disabled:text-fg-fnt"
    >
      {children}
    </button>
  );
}

/** The kubeconfig as provenance, with both ways to change it in reach. */
function SourceLine({
  kubeconfig,
}: {
  kubeconfig: ReturnType<typeof useKubeconfigPath>;
}) {
  const read = readFile(kubeconfig.source);

  return (
    <div className="mt-5 flex flex-wrap items-baseline gap-x-3 gap-y-1 border-t border-hair pt-2.5 text-[11px] text-fg-fnt">
      <span>Read from</span>
      <span className="break-all font-mono text-fg-mut">
        {read ?? "the default lookup"}
      </span>
      <Act
        onClick={() => void kubeconfig.choose()}
        disabled={kubeconfig.isPending}
      >
        Change…
      </Act>
      <Act onClick={() => void kubeconfig.reload()}>Reload</Act>
      {kubeconfig.overridePath && (
        <Act
          onClick={() => kubeconfig.clearPath()}
          disabled={kubeconfig.isPending}
        >
          Use the default
        </Act>
      )}
    </div>
  );
}

/**
 * Two states in one, because they are the same question answered
 * differently by the same facts: whether any of the files the app would
 * read is actually there.
 */
function NoClusters({
  kubeconfig,
}: {
  kubeconfig: ReturnType<typeof useKubeconfigPath>;
}) {
  const t = useT();
  const source = kubeconfig.source;
  const found = source?.candidates.some((c) => c.exists) ?? false;
  const counts = source?.counts;

  if (found) {
    return (
      <>
        <Heading
          title={t("empty", "configHasNoClusters")}
          sub={t("empty", "configHasNoClustersSub")}
        />
        <div className="mt-4 flex flex-wrap items-baseline gap-x-3 text-[11px]">
          <Act onClick={() => void kubeconfig.choose()}>
            Choose a different file…
          </Act>
          <Act onClick={() => void kubeconfig.reload()}>Reload</Act>
        </div>
        <Machine>
          <span>Read</span>
          <Mono>{readFile(source)}</Mono>
          {counts && (
            <span>
              · {count(counts.contexts, "context")},{" "}
              {count(counts.clusters, "cluster")}, {count(counts.users, "user")}
            </span>
          )}
          {source?.error && <Mono>{source.error}</Mono>}
        </Machine>
      </>
    );
  }

  return (
    <>
      <Heading
        title={t("empty", "notConnectedYet")}
        sub={t("empty", "noKubeconfigFound")}
      />
      <p className="mb-1 mt-5 text-[10px] uppercase tracking-[0.06em] text-fg-fnt">
        Get one running
      </p>
      <Route name="Docker Desktop" hint="enable Kubernetes in its settings" />
      <Route
        name="minikube · kind · k3d"
        hint="a local cluster in one command"
      />
      <Route
        name="Already have one elsewhere?"
        hint="point at its config file"
      />
      <div className="mt-4 flex flex-wrap items-baseline gap-x-3 text-[11px]">
        <Act onClick={() => void kubeconfig.choose()}>Choose a file…</Act>
        <Act onClick={() => void kubeconfig.reload()}>Look again</Act>
      </div>
      <Machine>
        <span>Looked at</span>
        {source?.candidates.map((candidate) => (
          <Mono key={candidate.path}>{candidate.path}</Mono>
        ))}
        {/* Which of the three lookups produced that list is the fact
            that explains it — an unset $KUBECONFIG is why there is only
            one path, and a set one is why there is not. */}
        <span>· {origin(source)}</span>
      </Machine>
    </>
  );
}

function origin(source: KubeconfigSource | undefined) {
  switch (source?.candidates[0]?.origin) {
    case "override":
      return "pinned in Settings";
    case "env":
      return "from $KUBECONFIG";
    default:
      return "$KUBECONFIG unset";
  }
}

/** A way to get a cluster, in the same row shape as a cluster. */
function Route({ name, hint }: { name: string; hint: string }) {
  return (
    <div className="grid grid-cols-[6px_1fr_auto] items-center gap-[9px] px-[7px] py-[5px] text-xs">
      <span className="h-1.5 w-1.5 rounded-full border border-fg-fnt" />
      <span className="truncate text-fg-mid">{name}</span>
      <span className="whitespace-nowrap text-[11px] text-fg-fnt">{hint}</span>
    </div>
  );
}

/**
 * Waiting, with the two things a wait has to say: how long it has been,
 * and how to stop it.
 */
function Connecting({
  context,
  startedAt,
  onCancel,
}: {
  context: string;
  startedAt: number | null;
  onCancel: () => void;
}) {
  const elapsed = useRealtimeAge(
    startedAt ? new Date(startedAt).toISOString() : null
  );
  const info = useClusterStore((s) =>
    s.contexts.find((ctx) => ctx.name === context)
  );

  return (
    <>
      <div className="flex items-start gap-2.5">
        {/* The one screen whose whole message is "something is happening":
            it says so with motion, not just with an ellipsis. */}
        <Spinner size="sm" aria-hidden className="mt-0.5 text-fg-fnt" />
        <Heading
          title={`Connecting to ${context}…`}
          sub={
            info?.exec_command
              ? "Your cluster is asking who you are. This can open a browser window."
              : "Waiting for the cluster's API server to answer."
          }
        />
      </div>
      <div className="mt-4 flex flex-wrap items-baseline gap-x-3 text-[11px] text-fg-fnt">
        <Act onClick={onCancel}>Cancel</Act>
        {startedAt && <span className="font-mono">{elapsed}</span>}
      </div>
      {/* Either fact is the machine's own; neither is invented, and when
          the kubeconfig carries neither, nothing is printed. */}
      {(info?.exec_command || info?.server) && (
        <Machine>
          {info.exec_command ? (
            <>
              <span>Running</span>
              <Mono>{info.exec_command}</Mono>
            </>
          ) : (
            <>
              <span>Reaching</span>
              <Mono>{info.server}</Mono>
            </>
          )}
        </Machine>
      )}
    </>
  );
}

function Failed({
  context,
  message,
  onRetry,
}: {
  context: string;
  message: string;
  onRetry: () => void;
}) {
  const server = useClusterStore(
    (s) => s.contexts.find((ctx) => ctx.name === context)?.server
  );

  return (
    <>
      <Heading
        title="The cluster did not answer"
        sub={`${context} is not reachable from this machine — it may be off, or behind a VPN.`}
      />
      <div className="mt-4 flex flex-wrap items-baseline gap-x-3 text-[11px] text-fg-fnt">
        <Act onClick={onRetry}>Retry</Act>
        <span>or pick another below</span>
      </div>
      <Machine tone="error">
        <Mono>{verbatim(message)}</Mono>
      </Machine>
      {server && (
        <Machine>
          <span>Server</span>
          <Mono>{server}</Mono>
        </Machine>
      )}
    </>
  );
}

/**
 * The path that was actually read: the first candidate that exists, since
 * that is the one `Kubeconfig::read` opens.
 */
function readFile(source: KubeconfigSource | undefined) {
  return source?.candidates.find((candidate) => candidate.exists)?.path ?? null;
}

function count(n: number, noun: string) {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}
