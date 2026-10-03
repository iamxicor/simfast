import os from "node:os";
import path from "node:path";

// Unix socket paths are limited to ~104 bytes on macOS, so keep them short.
export const runDir = () => path.join("/tmp", `simfast-${os.userInfo().uid}`);
export const sockPath = (udid) => path.join(runDir(), `${udid.slice(0, 8)}.sock`);
export const logPath = (udid) => path.join(runDir(), `${udid.slice(0, 8)}.log`);
