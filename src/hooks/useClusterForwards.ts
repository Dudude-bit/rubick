/**
 * Bringing a saved port-forward up: on its own when the reader asked for
 * that, and otherwise when they press the row.
 *
 * The two halves of one decision. A forward is a listening socket on this
 * machine and a connection into the cluster, so it is not started because
 * somebody once pressed a button — but a configured integration whose tunnel
 * is down should not vanish from the sidebar either, because vanishing is
 * indistinguishable from never having been set up.
 *
 * So a saved forward always draws its row. `autoStart` decides only whether
 * the reader has to press it.
 */

import { useEffect, useRef } from "react";

import { commands } from "@/lib/commands";
import { connectOf, forward, type Forwarded } from "@/integrations";
import type { ServiceInfo } from "@/generated/types";
import {
  forwardsFor,
  useClusterForwardStore,
  type ForwardPreference,
} from "@/stores/clusterForwardStore";
import { useClusterStore } from "@/stores/clusterStore";

/** Whether this app is already forwarding that local port. */
async function alreadyUp(localPort: number): Promise<boolean> {
  const sessions = await commands.listPortForwards().catch(() => []);
  return sessions.some((session) => session.localPort === localPort);
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
 * Sessions this app has open onto the same Service, whatever port they are on.
 *
 * Reconnecting an integration picks a fresh local port, and the tunnel the
 * previous address was made of stays up behind it — a socket nobody is
 * listening to and a connection into the cluster nobody is using, both alive
 * until the app is restarted. They are stopped rather than left.
 */
async function orphansOf(
  preference: ForwardPreference,
  keep: number | null
): Promise<string[]> {
  const sessions = await commands.listPortForwards().catch(() => []);
  return sessions
    .filter(
      (session) =>
        session.namespace === preference.namespace &&
        session.remotePort === preference.remotePort &&
        session.localPort !== keep
    )
    .map((session) => session.id);
}

/**
 * Put a saved forward back up.
 *
 * The local port is kept where it can be, because the integration's address
 * is `http://localhost:<port>` and an address that moves under a connection
 * is worse than a slow one. Where the machine has taken it since — another
 * app, another cluster's tunnel — a free one is chosen and **the connection's
 * address is rewritten to match**, which is the half that makes moving safe:
 * the token and the TLS setting are untouched, since saving without a token
 * keeps the stored one.
 */
export async function wake(
  vendorId: string,
  preference: ForwardPreference
): Promise<Forwarded> {
  if (await alreadyUp(preference.localPort)) {
    for (const id of await orphansOf(preference, preference.localPort)) {
      await commands.stopPortForward(id).catch(() => undefined);
    }
    return {
      ...preference,
      pod: "",
      url: `http://localhost:${preference.localPort}`,
    };
  }

  const service = await serviceOf(preference);
  if (!service) {
    throw new Error(
      `${preference.namespace}/${preference.service} is not in this cluster any more, so there is nothing to forward to.`
    );
  }

  // Anything already tunnelling to this Service is from a previous address.
  for (const id of await orphansOf(preference, null)) {
    await commands.stopPortForward(id).catch(() => undefined);
  }

  const found = await forward(
    service,
    [preference.remotePort],
    preference.localPort
  );
  if (found.localPort !== preference.localPort) {
    await moveAddress(vendorId, preference, found.localPort);
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
  preference: ForwardPreference,
  localPort: number
): Promise<void> {
  useClusterForwardStore
    .getState()
    .remember(useClusterStore.getState().currentContext ?? "", vendorId, {
      ...preference,
      localPort,
    });

  const connect = connectOf(vendorId);
  if (!connect) return;
  const saved = await connect.read().catch(() => null);
  await connect
    .save({
      url: `http://localhost:${localPort}`,
      authType: saved?.authType ?? "none",
      // Empty, never null: the backend keeps the stored one when nothing is
      // sent, and the token has never been in this window to send back.
      token: "",
      insecureTls: saved?.insecureTls ?? false,
    })
    .catch(() => undefined);
}

/**
 * Wake every forward this cluster asked to have up.
 *
 * Mounted once, beside the other shell-level hooks. Runs per context and only
 * for the ones marked `autoStart`; everything else waits to be pressed.
 */
export function useClusterForwards(): void {
  const context = useClusterStore((state) => state.currentContext);
  const isConnected = useClusterStore((state) => state.isConnected);
  const forwards = useClusterForwardStore((state) => state.forwards);
  // One attempt per cluster per session. A forward that could not come up is
  // not retried in a loop behind the reader's back — the row is there and
  // pressing it tries again, which is a person deciding rather than a timer.
  const tried = useRef(new Set<string>());

  useEffect(() => {
    if (!isConnected || context === null) return;
    for (const [vendorId, preference] of forwardsFor(forwards, context)) {
      if (!preference.autoStart) continue;
      const key = `${context}/${vendorId}`;
      if (tried.current.has(key)) continue;
      tried.current.add(key);
      void wake(vendorId, preference).catch(() => undefined);
    }
  }, [context, isConnected, forwards]);
}
