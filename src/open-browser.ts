import { spawn } from "child_process";

/**
 * Best-effort open of a URL in the user's default browser. Never throws: on a
 * headless box (no DISPLAY, no `open`) the caller is expected to have printed
 * the URL so the user can navigate manually.
 */
export function openInBrowser(url: string): void {
  let cmd: string;
  let args: string[];
  if (process.platform === "darwin") {
    cmd = "open";
    args = [url];
  } else if (process.platform === "win32") {
    // `start` is a cmd.exe builtin; the empty "" is the window title arg.
    cmd = "cmd";
    args = ["/c", "start", "", url];
  } else {
    cmd = "xdg-open";
    args = [url];
  }
  try {
    const child = spawn(cmd, args, { detached: true, stdio: "ignore" });
    // A missing opener surfaces as an async 'error' event, never as a throw, so
    // this listener — not the catch below — is what actually keeps a headless
    // box alive. Unhandled, that event terminates the process.
    child.on("error", () => {
      /* URL was already printed; the user can open it manually. */
    });
    child.unref();
  } catch {
    // If we can't spawn (no DISPLAY, no `open` on a headless box), the URL
    // print earlier still lets the user navigate manually. Don't fail.
  }
}
