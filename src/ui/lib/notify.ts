import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";

export interface Notice {
  title: string;
  body: string;
}

export type Delivery = "delivered" | "refused" | "failed";

let granted: boolean | null = null;

/**
 * A desktop notification, for the moments the person is not looking at the
 * window. Asks for permission once; a refusal is an answer, not an error,
 * and the caller says so in the app instead.
 */
export async function notify(notice: Notice): Promise<Delivery> {
  try {
    if (granted === null) {
      granted = await isPermissionGranted();
      if (!granted) granted = (await requestPermission()) === "granted";
    }
    if (!granted) return "refused";
    sendNotification(notice);
    return "delivered";
  } catch {
    return "failed";
  }
}
