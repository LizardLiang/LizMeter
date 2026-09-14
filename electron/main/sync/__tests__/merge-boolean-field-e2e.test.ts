// @vitest-environment node
// End-to-end regression for the 2026-09-14 stuck-merge-pass bug, through the same two-device
// harness the rest of this codebase's sync suite uses. Device A publishes a `todo_states` upsert
// carrying a raw JS boolean field value -- the exact shape of peer oplog line 165
// (opId fd39a710-c766-4aab-b8eb-6328f8da1200, is_completed: false) that stalled the user's real
// merge pass, and of any entry a peer running an older build (pre producer-side fix) still
// writes. Device B then merges it.
//
// This is only a meaningful regression test because better-sqlite3-shim.ts now rejects a boolean
// bind the same way real better-sqlite3 does (see this file's sibling debt fix) -- without that
// hardening, the shim would silently tolerate the bug and this test would pass whether or not
// merge-engine.ts's toBindValue coercion exists.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockPaths = { userData: "" };

vi.mock("electron", () => ({
  app: {
    getPath: (name: string) => {
      if (name === "userData") return mockPaths.userData;
      throw new Error(`unexpected app.getPath(${name})`);
    },
  },
}));

import { listTodoStates } from "../../database.ts";
import { createTwoDeviceHarness, type TwoDeviceHarness } from "../../../../src/test/two-device-harness.ts";
import { getOrAssignDeviceNumber } from "../device-identity.ts";
import { tick } from "../hlc.ts";
import { appendOplogEntry, buildUpsertEntry } from "../oplog.ts";

let harness: TwoDeviceHarness;

beforeEach(() => {
  harness = createTwoDeviceHarness(mockPaths);
});

afterEach(() => {
  harness.cleanup();
});

describe("a peer-published raw-boolean todo_states field merges without throwing", () => {
  it("device B applies device A's is_completed: false / is_default: false without a bind-type crash", () => {
    const rowUuid = "11111111-2222-3333-4444-555555555555";

    harness.as(harness.deviceA, () => {
      const deviceNumber = getOrAssignDeviceNumber(harness.deviceA.db);
      const hlc = tick(harness.deviceA.db, deviceNumber);
      const entry = buildUpsertEntry(hlc, "todo_states", rowUuid, {
        label: { value: "Staged", hlc },
        color: { value: "#7aa2f7", hlc },
        // Raw JS booleans, mirroring peer oplog line 165's shape -- not the 0/1 a fixed producer
        // now writes, but exactly what an already-written entry or an older peer build still
        // carries.
        is_completed: { value: false, hlc },
        is_default: { value: false, hlc },
        created_at: { value: new Date(hlc.physicalMs).toISOString(), hlc },
      });
      appendOplogEntry(harness.sharedDir, harness.deviceA.deviceId, entry);
    });

    expect(() => harness.sync(harness.deviceB)).not.toThrow();

    const staged = harness.as(harness.deviceB, () => listTodoStates().find((s) => s.label === "Staged"));
    expect(staged).toBeDefined();
    expect(staged?.isCompleted).toBe(false);
    expect(staged?.isDefault).toBe(false);
  });
});
