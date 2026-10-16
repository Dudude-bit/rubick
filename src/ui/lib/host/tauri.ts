// What the desktop window can do that a browser tab cannot do the same way:
// pick files, write the clipboard, open a link outside the app. The only
// file besides the IPC adapter that names a Tauri module.
import { listen } from "@tauri-apps/api/event";

export {
  open as pickPath,
  save as pickSavePath,
} from "@tauri-apps/plugin-dialog";
export { writeText as copyText } from "@tauri-apps/plugin-clipboard-manager";
export { open as openOutside } from "@tauri-apps/plugin-shell";
export {
  getCurrent as launchLinks,
  onOpenUrl as onOpenLinks,
} from "@tauri-apps/plugin-deep-link";
export {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
export { WebviewWindow as HostWindow } from "@tauri-apps/api/webviewWindow";
export {
  check as checkForUpdate,
  type Update,
} from "@tauri-apps/plugin-updater";
export { relaunch } from "@tauri-apps/plugin-process";

/** The window gaining or losing focus, which the backend never hears about. */
export const onWindowFocus = (
  focused: boolean,
  handler: () => void
): Promise<() => void> =>
  listen(focused ? "tauri://focus" : "tauri://blur", handler);
