/**
 * Bringing a saved port-forward up: on its own when the reader asked for
 * that, and otherwise when they press the row.
 *
 * A forward is a listening socket on this machine and a connection into the
 * cluster, so it is not started just because somebody once pressed a button.
 * But a saved forward always draws its row, tunnel up or down: a row that
 * vanishes is indistinguishable from an integration never set up. `autoStart`
 * decides only whether the reader has to press it.
 */

import { SaidError } from "@/i18n/say";
import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { commands } from "@/lib/commands";
import {
  connectOf,
  forward,
  normalisedSubpath,
  type Forwarded,
} from "@/integrations";
import type { PortForwardSessionInfo, ServiceInfo } from "@/generated/types";
import {
  forwardsFor,
  useClusterForwardStore,
  type ForwardPreference,
} from "@/stores/clusterForwardStore";
import { useClusterStore } from "@/stores/clusterStore";

/**
 * The cluster whose tunnel this app has listening on a local port, if any.
 * Every cluster's tunnels are listed, and a parked tab keeps its cluster's
 * up: one on this cluster's saved address answers this cluster's queries
 * with another cluster's data.
 */
export function holderOf(
  sessions: readonly PortForwardSessionInfo[],
  localPort: number
): string | null {
  return sessions.find((s) => s.localPort === localPort)?.context ?? null;
}

async function holder(localPort: number): Promise<string | null> {
  const sessions = await commands.listPortForwards().catch(() => []);
  return holderOf(sessions, localPort);
}

/**
 * The Service a preference names, as it is *now*.
 *
 * Read again rather than stored: its ports can be edited, and a preference
 * carrying a stale port would forward to nothing while looking right.
 */
async function serviceOf(
  preference: ForwardPreference
): Promise<ServiceInfo | null> {
  const services = await commands.listServices(null).catch(() => []);
  return (
    services.find(
      (service) =>
        service.name === preference.service &&
        service.namespace === preference.namespace
    ) ?? null
  );
}

/**
 * Sessions this app has open onto the same Service port, whatever local port
 * they are on.
 *
 * Reconnecting an integration picks a fresh local port and leaves the previous
 * tunnel up behind it: a socket nobody listens to and a cluster connection
 * nobody uses, both alive until the app restarts. They are stopped, not left.
 * Matched by the Service the session forwards through, never by its pod-side
 * port, which is the `targetPort` and not the port the reader chose.
 */
export function orphansIn(
  sessions: readonly PortForwardSessionInfo[],
  context: string,
  preference: ForwardPreference,
  keep: number | null
): string[] {
  return sessions
    .filter(
      ({ context: of, via, namespace, localPort }) =>
        of === context &&
        via.kind === "service" &&
        via.name === preference.service &&
        via.port === preference.remotePort &&
        namespace === preference.namespace &&
        localPort !== keep
    )
    .map((session) => session.id);
}

async function orphansOf(
  context: string,
  preference: ForwardPreference,
  keep: number | null
): Promise<string[]> {
  const sessions = await commands.listPortForwards().catch(() => []);
  return orphansIn(sessions, context, preference, keep);
}

/**
 * Put a saved forward back up.
 *
 * The local port is kept where it can be, because the integration's address
 * is `http://localhost:<port>` and an address that moves under a connection
 * is worse than a slow one. Where the machine has taken it since — another
 * app, another cluster's tunnel — a free one is chosen and **the connection's
 * address is rewritten to match**. The token and the TLS setting are
 * untouched, since saving without a token keeps the stored one.
 */
export async function wake(
  vendorId: string,
  context: string,
  preference: ForwardPreference
): Promise<Forwarded> {
  if ((await holder(preference.localPort)) === context) {
    for (const id of await orphansOf(
      context,
      preference,
      preference.localPort
    )) {
      await commands.stopPortForward(id).catch(() => undefined);
    }
    const subpath = normalisedSubpath(preference.subpath);
    return {
      ...preference,
      subpath,
      url: `http://localhost:${preference.localPort}${subpath}`,
    };
  }

  const service = await serviceOf(preference);
  if (!service) {
    throw new SaidError(
      {
        key: "forwardServiceGone",
        values: { where: `${preference.namespace}/${preference.service}` },
      },
      `${preference.namespace}/${preference.service} is not in this cluster any more, so there is nothing to forward to.`
    );
  }

  // Anything already tunnelling to this Service is from a previous address.
  for (const id of await orphansOf(context, preference, null)) {
    await commands.stopPortForward(id).catch(() => undefined);
  }

  const found = await forward(
    service,
    [preference.remotePort],
    preference.localPort,
    preference.subpath
  );
  if (found.localPort !== preference.localPort) {
    await moveAddress(vendorId, context, preference, found.localPort);
  }
  return found;
}

/**
 * Follow the forward to its new port, in the store and in the connection.
 *
 * Both, or the app disagrees with itself: the store decides which port to try
 * next time and the saved connection is what every query actually goes to.
 */
async function moveAddress(
  vendorId: string,
  context: string,
  preference: ForwardPreference,
  localPort: number
): Promise<void> {
  useClusterForwardStore.getState().remember(context, vendorId, {
    ...preference,
    localPort,
  });

  const connect = connectOf(vendorId);
  if (!connect) return;
  const saved = await connect.read().catch(() => null);
  await connect
    .save(context, {
      url: `http://localhost:${localPort}${normalisedSubpath(preference.subpath)}`,
      authType: saved?.authType ?? "none",
      // Empty, never null: the backend keeps the stored one when nothing is
      // sent, and the token has never been in this window to send back.
      token: "",
      insecureTls: saved?.insecureTls ?? false,
    })
    .catch(() => undefined);
}

/**
 * Wake a vendor's saved forward because the reader opened its page.
 *
 * Tunnels die with the app, so after a relaunch the page behind one opens
 * onto "could not ask it anything". Navigating here names the vendor as
 * plainly as pressing its sidebar row would: one attempt per mount, nothing
 * when the tunnel is already up, and the row stays the retry for an attempt
 * that failed.
 */
export function useWakeOnVisit(vendorId: string): void {
  const context = useClusterStore((state) => state.currentContext);
  const forwards = useClusterForwardStore((state) => state.forwards);
  const queryClient = useQueryClient();
  const tried = useRef(false);

  useEffect(() => {
    if (tried.current || context === null) return;
    const preference = forwards[context]?.[vendorId];
    if (!preference) return;
    tried.current = true;
    void (async () => {
      if ((await holder(preference.localPort)) === context) return;
      await wake(vendorId, context, preference);
      // Everything asked before the tunnel came up was answered by a dead
      // socket — including the verdict this page opened onto.
      await queryClient.invalidateQueries();
    })().catch(() => undefined);
  }, [context, forwards, vendorId, queryClient]);
}

/**
 * Wake every forward this cluster asked to have up.
 *
 * Mounted once, beside the other shell-level hooks. Runs per context and only
 * for the ones marked `autoStart`; everything else waits to be pressed —
 * except a forward whose address another cluster's tunnel is answering,
 * which would read that cluster's data until this one had its own.
 */
export function useClusterForwards(): void {
  const context = useClusterStore((state) => state.currentContext);
  const isConnected = useClusterStore((state) => state.isConnected);
  const forwards = useClusterForwardStore((state) => state.forwards);
  const queryClient = useQueryClient();
  // One attempt per cluster per session. A forward that could not come up is
  // not retried in a loop behind the reader's back; pressing the row is the
  // retry.
  const tried = useRef(new Set<string>());

  useEffect(() => {
    if (!isConnected || context === null) return;
    const saved = forwardsFor(forwards, context);
    if (saved.length === 0) return;
    let left = false;
    void commands
      .listPortForwards()
      .catch(() => [])
      .then((sessions) => {
        if (left) return;
        for (const [vendorId, preference] of saved) {
          const held = holderOf(sessions, preference.localPort);
          const borrowed = held !== null && held !== context;
          const key = `${context}/${vendorId}`;
          if (!borrowed && (!preference.autoStart || tried.current.has(key)))
            continue;
          tried.current.add(key);
          void wake(vendorId, context, preference)
            // Anything asked before the tunnel came up was answered by a dead
            // socket and cached as such; the probe and every page verdict have
            // to be asked again now that there is somewhere to ask.
            .then(() => queryClient.invalidateQueries())
            .catch(() => undefined);
        }
      });
    return () => {
      left = true;
    };
  }, [context, isConnected, forwards, queryClient]);
}
