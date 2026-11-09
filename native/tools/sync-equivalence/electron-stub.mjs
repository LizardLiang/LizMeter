// Stand-in for `electron` when the TypeScript sync engine runs under plain node.
// `app.getPath("userData")` comes from LIZMETER_REAL_DB_USER_DATA, always a temp folder the harness made.
import os from "node:os";

export const app = {
  getPath(name) {
    if (name === "userData") return process.env.LIZMETER_REAL_DB_USER_DATA ?? os.tmpdir();
    throw new Error(`Unexpected Electron app.getPath(${name}) in the sync equivalence harness`);
  },
};

export class Notification {
  static isSupported() {
    return false;
  }
}
