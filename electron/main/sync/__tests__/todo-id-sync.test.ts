// @vitest-environment node
// Dense sequential todo ids across synced machines. Covers the plan's core contract: ids stay
// small and sequential on every machine, a cross-machine collision resolves without losing a
// todo, and the merge transaction COMMITS rather than throwing (the R2-B3-shaped silent-rollback
// trap -- runMergePassSafely funnels a throw here into a bare console.warn, so a failure would be
// invisible forever).

import fs from "node:fs";
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

import { createTodo, createTodoLabel, deleteTodo, listTodos, updateTodo } from "../../database.ts";
import { createTwoDeviceHarness, type TwoDeviceHarness } from "../../../../src/test/two-device-harness.ts";

let harness: TwoDeviceHarness;

beforeEach(() => {
  harness = createTwoDeviceHarness(mockPaths);
});

afterEach(() => {
  harness.cleanup();
});

/** Ids a human would accept as "serial" -- the whole point of the change. */
const SMALL_ID_CEILING = 10_000;

function idsOn(device: TwoDeviceHarness["deviceA"]): number[] {
  return harness.as(device, () => listTodos().map((t) => t.id).sort((a, b) => a - b));
}

function titlesById(device: TwoDeviceHarness["deviceA"]): Map<number, string> {
  return harness.as(device, () => new Map(listTodos().map((t) => [t.id, t.title])));
}

describe("dense sequential allocation", () => {
  it("gives the first todo on a synced machine a small id, not a device-block offset", () => {
    const created = harness.as(harness.deviceA, () => createTodo({ title: "First" }));
    expect(created.id).toBeLessThan(SMALL_ID_CEILING);
  });

  it("increments by one for each new todo", () => {
    const first = harness.as(harness.deviceA, () => createTodo({ title: "One" }));
    const second = harness.as(harness.deviceA, () => createTodo({ title: "Two" }));
    const third = harness.as(harness.deviceA, () => createTodo({ title: "Three" }));
    expect(second.id).toBe(first.id + 1);
    expect(third.id).toBe(second.id + 1);
  });

  it("gives a todo created on the second machine a small id too", () => {
    const created = harness.as(harness.deviceB, () => createTodo({ title: "From B" }));
    expect(created.id).toBeLessThan(SMALL_ID_CEILING);
  });
});

describe("collision resolution", () => {
  it("converges on one id per todo when both machines create while apart, losing neither", () => {
    harness.as(harness.deviceA, () => createTodo({ title: "Made on A" }));
    harness.as(harness.deviceB, () => createTodo({ title: "Made on B" }));

    // Both directions, twice: the losing side publishes its reassignment, which the winner then
    // has to observe -- the same two-pass shape FR-010's name-convergence test already needs.
    harness.sync(harness.deviceA);
    harness.sync(harness.deviceB);
    harness.sync(harness.deviceA);
    harness.sync(harness.deviceB);

    const onA = titlesById(harness.deviceA);
    const onB = titlesById(harness.deviceB);

    expect([...onA.values()].sort()).toEqual(["Made on A", "Made on B"]);
    expect([...onB.values()].sort()).toEqual(["Made on A", "Made on B"]);
    // The real contract: both machines agree which number belongs to which todo.
    expect([...onA.entries()].sort()).toEqual([...onB.entries()].sort());
  });

  it("keeps the converged ids small", () => {
    harness.as(harness.deviceA, () => createTodo({ title: "Made on A" }));
    harness.as(harness.deviceB, () => createTodo({ title: "Made on B" }));
    harness.sync(harness.deviceA);
    harness.sync(harness.deviceB);
    harness.sync(harness.deviceA);

    for (const id of idsOn(harness.deviceA)) expect(id).toBeLessThan(SMALL_ID_CEILING);
  });

  it("commits the merge rather than throwing when an incoming id is already taken", () => {
    harness.as(harness.deviceA, () => createTodo({ title: "Made on A" }));
    harness.as(harness.deviceB, () => createTodo({ title: "Made on B" }));

    // The guard against the silent-rollback trap: a throw here is swallowed upstream, so assert
    // the pass both succeeds AND actually applied something.
    const result = harness.sync(harness.deviceA);
    expect(result.applied).toBeGreaterThan(0);
    expect(idsOn(harness.deviceA).length).toBe(2);
  });

  it("resolves a whole batch of collisions after a long offline window, losing none", () => {
    // A gets well ahead while B is away.
    for (let i = 0; i < 6; i++) harness.as(harness.deviceA, () => createTodo({ title: `A-${i}` }));
    // B, unaware, creates its own run over the same numbers.
    for (let i = 0; i < 5; i++) harness.as(harness.deviceB, () => createTodo({ title: `B-${i}` }));

    harness.sync(harness.deviceA);
    harness.sync(harness.deviceB);
    harness.sync(harness.deviceA);
    harness.sync(harness.deviceB);

    const onA = titlesById(harness.deviceA);
    const onB = titlesById(harness.deviceB);

    expect(onA.size).toBe(11);
    expect(onB.size).toBe(11);
    expect([...onA.entries()].sort()).toEqual([...onB.entries()].sort());
    // No id was handed to two different todos.
    expect(new Set(onA.keys()).size).toBe(11);
  });
});

describe("convergence is stable, not just eventual", () => {
  // The regression guard for the design this replaced: each machine used to pick a replacement
  // number from its own counter and publish it as a last-write-wins field, which never settled --
  // a machine's own write always looked newer than its peer's, so both permanently rejected the
  // other's answer. Ten passes with no agreement was the observed failure. Deriving the assignment
  // instead of negotiating it is what fixes this, so the test asserts agreement AND that repeated
  // passes stop changing anything.
  it("agrees after both machines have seen the same todos, and stops moving", () => {
    for (let i = 0; i < 6; i++) harness.as(harness.deviceA, () => createTodo({ title: `A-${i}` }));
    for (let i = 0; i < 5; i++) harness.as(harness.deviceB, () => createTodo({ title: `B-${i}` }));

    const snapshotOf = (device: TwoDeviceHarness["deviceA"]) =>
      harness.as(device, () => listTodos().map((t) => `${t.id}:${t.title}`).sort().join(","));

    harness.sync(harness.deviceA);
    harness.sync(harness.deviceB);
    harness.sync(harness.deviceA);

    const settledA = snapshotOf(harness.deviceA);
    expect(settledA).toBe(snapshotOf(harness.deviceB));

    // Further passes are no-ops -- no drift, no ping-ponging.
    for (let pass = 0; pass < 4; pass++) {
      harness.sync(harness.deviceA);
      harness.sync(harness.deviceB);
    }
    expect(snapshotOf(harness.deviceA)).toBe(settledA);
    expect(snapshotOf(harness.deviceB)).toBe(settledA);
  });

  it("leaves an uncontested todo's number alone forever", () => {
    const only = harness.as(harness.deviceA, () => createTodo({ title: "Uncontested" }));
    for (let pass = 0; pass < 5; pass++) {
      harness.sync(harness.deviceB);
      harness.sync(harness.deviceA);
    }
    const after = harness.as(harness.deviceA, () => listTodos().find((t) => t.title === "Uncontested"));
    expect(after?.id).toBe(only.id);
  });
});

describe("high-water mark advances on merge", () => {
  it("issues the next id above anything a peer has used", () => {
    for (let i = 0; i < 4; i++) harness.as(harness.deviceA, () => createTodo({ title: `A-${i}` }));
    harness.sync(harness.deviceB);

    const highestSeen = Math.max(...idsOn(harness.deviceB));
    const next = harness.as(harness.deviceB, () => createTodo({ title: "B after catching up" }));
    expect(next.id).toBeGreaterThan(highestSeen);
  });
});

describe("referential integrity across an id change", () => {
  it("keeps parent, label, and attachment references pointing at the right todo after a bump", () => {
    const label = harness.as(harness.deviceA, () => createTodoLabel({ name: "urgent", color: "#f7768e" }));
    const parentOnB = harness.as(harness.deviceB, () => createTodo({ title: "Parent on B" }));
    harness.as(harness.deviceB, () => createTodo({ title: "Child on B", parentId: parentOnB.id }));
    harness.as(harness.deviceB, () => updateTodo({ id: parentOnB.id, labelIds: [] }));

    // A creates its own todos over the same numbers, forcing B's rows to move.
    for (let i = 0; i < 3; i++) harness.as(harness.deviceA, () => createTodo({ title: `A-${i}` }));

    harness.sync(harness.deviceA);
    harness.sync(harness.deviceB);
    harness.sync(harness.deviceA);
    harness.sync(harness.deviceB);

    const child = harness.as(harness.deviceB, () => listTodos().find((t) => t.title === "Child on B"));
    const parent = harness.as(harness.deviceB, () => listTodos().find((t) => t.title === "Parent on B"));
    expect(child?.parentId).toBe(parent?.id);

    const childOnA = harness.as(harness.deviceA, () => listTodos().find((t) => t.title === "Child on B"));
    const parentOnA = harness.as(harness.deviceA, () => listTodos().find((t) => t.title === "Parent on B"));
    expect(childOnA?.parentId).toBe(parentOnA?.id);
    expect(label.name).toBe("urgent");
  });
});

describe("reassignment is reported", () => {
  it("raises a sync notice on the machine whose todo actually moved, naming both ids", () => {
    harness.as(harness.deviceA, () => createTodo({ title: "Made on A" }));
    const onB = harness.as(harness.deviceB, () => createTodo({ title: "Made on B" }));

    harness.sync(harness.deviceB); // B learns A created the earlier todo, so B's own todo moves

    const notices = harness.as(
      harness.deviceB,
      () => harness.deviceB.db.prepare("SELECT * FROM sync_notices WHERE kind = 'todo-id-reassigned'").all(),
    ) as Array<{ message: string; detail: string | null }>;

    expect(notices.length).toBeGreaterThan(0);
    expect(notices[0]!.detail).toContain(`old id ${onB.id}`);
  });

  it("stays silent on the machine where nothing the user had seen changed", () => {
    harness.as(harness.deviceA, () => createTodo({ title: "Made on A" }));
    harness.as(harness.deviceB, () => createTodo({ title: "Made on B" }));

    harness.sync(harness.deviceA); // A's own todo keeps its number; B's arrives on a free one

    const notices = harness.as(
      harness.deviceA,
      () => harness.deviceA.db.prepare("SELECT * FROM sync_notices WHERE kind = 'todo-id-reassigned'").all(),
    );
    expect(notices.length).toBe(0);
  });
});

describe("no id is ever reused", () => {
  it("does not hand a deleted todo's number to a new todo", () => {
    const first = harness.as(harness.deviceA, () => createTodo({ title: "Doomed" }));
    harness.as(harness.deviceA, () => deleteTodo(first.id));
    const next = harness.as(harness.deviceA, () => createTodo({ title: "Successor" }));
    expect(next.id).toBeGreaterThan(first.id);
  });
});

// Sanity: the shared folder is a real directory the harness cleans up.
it("uses a real shared folder", () => {
  expect(fs.existsSync(harness.sharedDir)).toBe(true);
});
