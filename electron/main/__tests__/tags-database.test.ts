// Tests for tag CRUD functions in database.ts
// Uses in-memory database (sql.js shim via vitest alias)

import { describe, it, expect, beforeEach } from "vitest";
import {
  initDatabase,
  createTag,
  listTags,
  updateTag,
  deleteTag,
  assignTag,
  unassignTag,
  listTagsForSession,
  saveSession,
  listSessions,
  deleteSession,
} from "../database.ts";

const SESSION_INPUT = {
  title: "Test session",
  timerType: "work" as const,
  plannedDurationSeconds: 1500,
  actualDurationSeconds: 1450,
};

const TAG_BLUE = { name: "Work", color: "#7aa2f7" };
const TAG_GREEN = { name: "Study", color: "#9ece6a" };

beforeEach(() => {
  initDatabase(":memory:");
});

// ─── createTag ───────────────────────────────────────────────────────────────

describe("createTag", () => {
  it("creates a tag and returns it with correct fields", () => {
    const tag = createTag(TAG_BLUE);
    expect(tag.id).toBeTypeOf("number");
    expect(tag.name).toBe("Work");
    expect(tag.color).toBe("#7aa2f7");
    expect(tag.createdAt).toBeTypeOf("string");
  });

  it("throws on duplicate name (case-insensitive)", () => {
    createTag(TAG_BLUE);
    expect(() => createTag({ name: "work", color: "#9ece6a" })).toThrow();
  });

  it("throws on invalid color", () => {
    expect(() => createTag({ name: "X", color: "#ffffff" })).toThrow();
  });
});

// ─── listTags ─────────────────────────────────────────────────────────────────

describe("listTags", () => {
  it("returns empty array when no tags exist", () => {
    expect(listTags()).toEqual([]);
  });

  it("returns tags ordered alphabetically by name", () => {
    createTag({ name: "Zzz", color: "#7aa2f7" });
    createTag({ name: "Aaa", color: "#9ece6a" });
    const tags = listTags();
    expect(tags[0].name).toBe("Aaa");
    expect(tags[1].name).toBe("Zzz");
  });
});

// ─── updateTag ────────────────────────────────────────────────────────────────

describe("updateTag", () => {
  it("updates name and color", () => {
    const tag = createTag(TAG_BLUE);
    const updated = updateTag({ id: tag.id, name: "Focus", color: "#bb9af7" });
    expect(updated.name).toBe("Focus");
    expect(updated.color).toBe("#bb9af7");
    expect(updated.id).toBe(tag.id);
  });

  it("throws when id does not exist", () => {
    expect(() => updateTag({ id: 99999, name: "X", color: "#7aa2f7" })).toThrow();
  });
});

// ─── deleteTag ────────────────────────────────────────────────────────────────

describe("deleteTag", () => {
  it("removes the tag from the list", () => {
    const tag = createTag(TAG_BLUE);
    deleteTag(tag.id);
    expect(listTags()).toHaveLength(0);
  });

  it("does not throw for non-existent id", () => {
    expect(() => deleteTag(99999)).not.toThrow();
  });
});

// ─── assignTag / unassignTag / listTagsForSession ────────────────────────────

describe("tag assignment", () => {
  it("assigns tag to session and retrieves it", () => {
    const session = saveSession(SESSION_INPUT);
    const tag = createTag(TAG_BLUE);
    assignTag({ sessionId: session.id, tagId: tag.id });
    const tags = listTagsForSession(session.id);
    expect(tags).toHaveLength(1);
    expect(tags[0].name).toBe("Work");
  });

  it("assign is idempotent", () => {
    const session = saveSession(SESSION_INPUT);
    const tag = createTag(TAG_BLUE);
    assignTag({ sessionId: session.id, tagId: tag.id });
    assignTag({ sessionId: session.id, tagId: tag.id });
    expect(listTagsForSession(session.id)).toHaveLength(1);
  });

  it("unassigns tag from session", () => {
    const session = saveSession(SESSION_INPUT);
    const tag = createTag(TAG_BLUE);
    assignTag({ sessionId: session.id, tagId: tag.id });
    unassignTag({ sessionId: session.id, tagId: tag.id });
    expect(listTagsForSession(session.id)).toHaveLength(0);
  });

  it("returns empty array for session with no tags", () => {
    const session = saveSession(SESSION_INPUT);
    expect(listTagsForSession(session.id)).toHaveLength(0);
  });
});

// ─── CASCADE deletes (Apollo M-1) ─────────────────────────────────────────────

describe("cascade deletes", () => {
  it("deleting a tag removes session_tags rows (PRAGMA foreign_keys = ON)", () => {
    const session = saveSession(SESSION_INPUT);
    const tag = createTag(TAG_BLUE);
    assignTag({ sessionId: session.id, tagId: tag.id });

    deleteTag(tag.id); // should cascade

    expect(listTagsForSession(session.id)).toHaveLength(0);
  });

  it("deleting a session removes its session_tags rows", () => {
    const session = saveSession(SESSION_INPUT);
    const tag = createTag(TAG_BLUE);
    assignTag({ sessionId: session.id, tagId: tag.id });

    deleteSession(session.id);

    // listTagsForSession returns empty for deleted session
    expect(listTagsForSession(session.id)).toHaveLength(0);
  });
});

// ─── listSessions with tagId filter ───────────────────────────────────────────

describe("listSessions", () => {
  it("returns empty tags array for sessions with no tags", () => {
    saveSession(SESSION_INPUT);
    const result = listSessions();
    expect(result.sessions[0].tags).toEqual([]);
  });

  it("populates tags array for sessions with tags", () => {
    const session = saveSession(SESSION_INPUT);
    const tag = createTag(TAG_BLUE);
    assignTag({ sessionId: session.id, tagId: tag.id });

    const result = listSessions();
    expect(result.sessions[0].tags).toHaveLength(1);
    expect(result.sessions[0].tags[0].name).toBe("Work");
  });

  it("filters sessions by tagId", () => {
    const s1 = saveSession({ ...SESSION_INPUT, title: "Tagged" });
    const s2 = saveSession({ ...SESSION_INPUT, title: "Untagged" });
    const tagBlue = createTag(TAG_BLUE);
    const tagGreen = createTag(TAG_GREEN);

    assignTag({ sessionId: s1.id, tagId: tagBlue.id });
    assignTag({ sessionId: s2.id, tagId: tagGreen.id });

    const result = listSessions({ tagId: tagBlue.id });
    expect(result.total).toBe(1);
    expect(result.sessions[0].title).toBe("Tagged");
  });

  it("filtered total reflects only matching sessions", () => {
    const tag = createTag(TAG_BLUE);
    for (let i = 0; i < 3; i++) {
      const s = saveSession(SESSION_INPUT);
      if (i < 2) assignTag({ sessionId: s.id, tagId: tag.id });
    }

    const filtered = listSessions({ tagId: tag.id });
    const unfiltered = listSessions();

    expect(filtered.total).toBe(2);
    expect(unfiltered.total).toBe(3);
  });
});
