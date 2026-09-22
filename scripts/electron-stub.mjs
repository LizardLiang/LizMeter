import os from "node:os";

export const app = {
  getPath(name) {
    if (name === "userData") return process.env.LIZMETER_REAL_DB_USER_DATA ?? os.tmpdir();
    throw new Error(`Unexpected Electron app.getPath(${name}) in real-database verification`);
  },
};
