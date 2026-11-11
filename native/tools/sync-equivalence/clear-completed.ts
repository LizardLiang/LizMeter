// The TypeScript side of the clear-completed scenario (see clear-completed.mjs). Mirrors
// `clear_scenario` in native/crates/sync/src/bin/sync_cli.rs. Bundled and imported by
// clear-completed.mjs; every path comes from the caller.

import fs from "node:fs";
import path from "node:path";
import {
  clearCompletedTodos,
  createTodo,
  initDatabase,
  listTodoStates,
  updateTodo,
} from "../../../electron/main/database.ts";
import { invalidateDataDirCache } from "../../../electron/main/data-location.ts";
import { invalidateDeviceIdCache } from "../../../electron/main/sync/device-identity.ts";

export interface ClearDeviceDirs {
  dbPath: string;
  userData: string;
  shared: string;
}

export function tsClearScenario(d: ClearDeviceDirs, tag: string): { cleared: number } {
  process.env["LIZMETER_REAL_DB_USER_DATA"] = d.userData;
  fs.mkdirSync(d.userData, { recursive: true });
  fs.writeFileSync(path.join(d.userData, "data-location.json"), `${JSON.stringify({ dataDir: d.shared })}\n`, "utf8");
  invalidateDataDirCache();
  invalidateDeviceIdCache();
  initDatabase(d.dbPath);

  const done1 = createTodo({ title: `${tag}-done-1` });
  const done2 = createTodo({ title: `${tag}-done-2` });
  createTodo({ title: `${tag}-open` });
  createTodo({ title: `${tag}-child`, parentId: done1.id });
  const doneState = listTodoStates().find((s) => s.isCompleted);
  if (!doneState) throw new Error("no completed state");
  for (const id of [done1.id, done2.id]) updateTodo({ id, stateId: doneState.id });
  return { cleared: clearCompletedTodos().count };
}
