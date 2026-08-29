import { describe, expect, it } from "vitest";
import type { Todo, TodoState } from "../../../../shared/types.ts";
import { ancestorIds, childrenOf, descendantIds, linkableChildren, linkableParents, wouldCycle } from "../todoTree.ts";

const state: TodoState = {
  id: 1,
  label: "Todo",
  color: "#7aa2f7",
  position: 0,
  isCompleted: false,
  isDefault: true,
  createdAt: "2026-01-01T00:00:00.000Z",
};

function makeTodo(id: number, parentId: number | null = null): Todo {
  return {
    id,
    title: `Todo ${id}`,
    notes: null,
    state,
    project: null,
    labels: [],
    milestone: null,
    priority: 0,
    startDate: null,
    dueDate: null,
    source: "user",
    sourceLabel: null,
    parentId,
    parentTitle: parentId === null ? null : `Todo ${parentId}`,
    childCount: 0,
    completedChildCount: 0,
    createdAt: "2026-05-08T00:00:00.000Z",
    completedAt: null,
  };
}

//  1 ── 2 ── 4
//    └─ 3
//  5 (unrelated)
const tree: Todo[] = [
  makeTodo(1),
  makeTodo(2, 1),
  makeTodo(3, 1),
  makeTodo(4, 2),
  makeTodo(5),
];

describe("descendantIds", () => {
  it("collects the whole subtree, not just direct children", () => {
    expect(descendantIds(tree, 1)).toEqual(new Set([2, 3, 4]));
  });

  it("returns an empty set for a leaf", () => {
    expect(descendantIds(tree, 4)).toEqual(new Set());
  });

  it("returns an empty set for an unknown id", () => {
    expect(descendantIds(tree, 99)).toEqual(new Set());
  });

  it("terminates on a cycle rather than looping forever", () => {
    // Only reachable if the main process guard were bypassed, but the walk must still return.
    const cyclic = [makeTodo(1, 2), makeTodo(2, 1)];
    expect(descendantIds(cyclic, 1)).toEqual(new Set([1, 2]));
  });
});

describe("ancestorIds", () => {
  it("walks every level up to the root", () => {
    expect(ancestorIds(tree, 4)).toEqual(new Set([2, 1]));
  });

  it("returns an empty set for a root", () => {
    expect(ancestorIds(tree, 1)).toEqual(new Set());
  });

  it("terminates on a cycle", () => {
    const cyclic = [makeTodo(1, 2), makeTodo(2, 1)];
    expect(ancestorIds(cyclic, 1)).toEqual(new Set([2, 1]));
  });
});

describe("wouldCycle", () => {
  it("rejects a todo as its own parent", () => {
    expect(wouldCycle(tree, 1, 1)).toBe(true);
  });

  it("rejects a descendant as the new parent", () => {
    expect(wouldCycle(tree, 1, 4)).toBe(true);
  });

  it("allows an unrelated todo as the new parent", () => {
    expect(wouldCycle(tree, 1, 5)).toBe(false);
  });

  it("allows moving a subtree under a deeper node elsewhere", () => {
    expect(wouldCycle(tree, 5, 4)).toBe(false);
  });
});

describe("childrenOf", () => {
  it("returns direct children only", () => {
    expect(childrenOf(tree, 1).map((t) => t.id)).toEqual([2, 3]);
  });

  it("returns nothing for a leaf", () => {
    expect(childrenOf(tree, 4)).toEqual([]);
  });
});

describe("linkableParents", () => {
  it("excludes the todo itself, its subtree, and the parent it already has", () => {
    // Candidates for todo 2, currently parented by 1: 4 is its child, so only 3 and 5 remain.
    expect(linkableParents(tree, 2, 1).map((t) => t.id)).toEqual([3, 5]);
  });

  it("offers every other todo to a top-level leaf", () => {
    expect(linkableParents(tree, 5, null).map((t) => t.id)).toEqual([1, 2, 3, 4]);
  });

  it("offers everything while the todo does not exist yet", () => {
    expect(linkableParents(tree, null, null).map((t) => t.id)).toEqual([1, 2, 3, 4, 5]);
  });
});

describe("linkableChildren", () => {
  it("excludes the todo itself, its ancestors, and todos already filed under it", () => {
    // Candidates to nest under 2: 1 is its ancestor, 4 is already there. 3 and 5 remain.
    expect(linkableChildren(tree, 2).map((t) => t.id)).toEqual([3, 5]);
  });

  it("allows pulling a grandchild up to be a direct child", () => {
    expect(linkableChildren(tree, 1).map((t) => t.id)).toEqual([4, 5]);
  });
});
