// Fixture oplog sets for the cross-implementation equivalence harness.
//
// Each scenario is a set of peer oplog files (JSON Lines) in two phases. The harness feeds phase 1 to
// both engines, then appends phase 2 and merges again, so deferral and retry are exercised, not only a
// single clean pass. Entries are written with fixed opIds, uuids and HLCs: both engines see byte-equal
// input and must produce identical rows.

export interface Scenario {
  name: string;
  /** file name (uuid.oplog.jsonl) to lines */
  phase1: Record<string, string[]>;
  phase2: Record<string, string[]>;
}

const BASE = 1_700_000_000_000;
const FAR_FUTURE = 4_102_444_800_000; // year 2100: always beyond the clock-drift tolerance

export const D1 = "aaaaaaaa-0000-4000-8000-000000000001";
export const D2 = "bbbbbbbb-0000-4000-8000-000000000002";
export const D3 = "cccccccc-0000-4000-8000-000000000003";
const DEVICE_NUMBER: Record<string, number> = { [D1]: 1, [D2]: 2, [D3]: 3 };

type Value = string | number | boolean | null;
type Hlc = { physicalMs: number; counter: number; deviceNumber: number };
type FieldSpec = Value | { value: Value; hlc: Hlc };

function hlc(ms: number, counter: number, deviceNumber: number): Hlc {
  return { physicalMs: ms, counter, deviceNumber };
}

function fieldsOf(fields: Record<string, FieldSpec>, at: Hlc): Record<string, { value: Value; hlc: Hlc }> {
  const out: Record<string, { value: Value; hlc: Hlc }> = {};
  for (const [k, v] of Object.entries(fields)) {
    out[k] = typeof v === "object" && v !== null ? v : { value: v, hlc: at };
  }
  return out;
}

function upsert(opId: string, at: Hlc, table: string, rowUuid: string, fields: Record<string, FieldSpec>): string {
  return JSON.stringify({ v: 1, opId, hlc: at, table, op: "upsert", rowUuid, fields: fieldsOf(fields, at) });
}

function del(opId: string, at: Hlc, table: string, rowUuid: string): string {
  return JSON.stringify({ v: 1, opId, hlc: at, table, op: "delete", rowUuid });
}

function link(opId: string, at: Hlc, table: string, op: "link" | "unlink", fromUuid: string, toUuid: string): string {
  return JSON.stringify({ v: 1, opId, hlc: at, table, op, fields: { fromUuid, toUuid } });
}

const file = (device: string): string => `${device}.oplog.jsonl`;

// --- the hand-written scenario: one case per rule the merge engine implements ---

function basics(): Scenario {
  const h = (ms: number, c: number, d: number): Hlc => hlc(BASE + ms, c, d);
  const iso = (ms: number): string => new Date(BASE + ms).toISOString();
  const T = (n: number): string => `0000000${n}-todo-4000-8000-0000000000${n}`.slice(0, 36);

  const d2: string[] = [];
  const d3: string[] = [];

  // States: 'Backlog' arrives earlier than the seeded one (incoming wins, seed uuid is replaced);
  // 'Todo' arrives later than the seed (the seed survives, the incoming uuid becomes an alias).
  d2.push(upsert("st-1", h(1, 0, 2), "todo_states", "state-backlog", { label: "Backlog", color: "#565f89", created_at: "2020-01-01T00:00:00.000Z", is_completed: false, is_default: false }));
  d2.push(upsert("st-2", h(2, 0, 2), "todo_states", "state-todo-late", { label: "todo", color: "#7aa2f7", created_at: "2099-01-01T00:00:00.000Z", is_default: true }));
  d2.push(upsert("st-3", h(3, 0, 2), "todo_states", "state-review", { label: "Review", color: "#e0af68", created_at: iso(3), is_completed: false, sync_order: "m" }));
  d3.push(upsert("st-4", h(4, 0, 3), "todo_states", "state-review-b", { label: "REVIEW", color: "#e0af68", created_at: iso(4), sync_order: "n" }));

  // Projects with sync_order, one without.
  d2.push(upsert("pr-1", h(5, 0, 2), "todo_projects", "proj-a", { name: "Alpha", color: "#7aa2f7", created_at: iso(5), sync_order: "b" }));
  d2.push(upsert("pr-2", h(6, 0, 2), "todo_projects", "proj-b", { name: "Beta", color: "#9ece6a", created_at: iso(6), sync_order: "a" }));
  d3.push(upsert("pr-3", h(7, 0, 3), "todo_projects", "proj-c", { name: "Gamma", color: "#bb9af7", created_at: iso(7) }));

  // Labels: same name, same created_at: the uuid tie-break decides on both machines.
  d2.push(upsert("lb-1", h(8, 0, 2), "todo_labels", "label-bug-2", { name: "bug", color: "#f7768e", created_at: iso(8) }));
  d3.push(upsert("lb-2", h(9, 0, 3), "todo_labels", "label-bug-1", { name: "BUG", color: "#9ece6a", created_at: iso(8) }));
  d3.push(upsert("lb-3", h(9, 1, 3), "todo_labels", "label-idea", { name: "idea", color: "#9ece6a", created_at: iso(9) }));

  d2.push(upsert("tg-1", h(10, 0, 2), "tags", "tag-focus", { name: "focus", color: "#7aa2f7", created_at: iso(10) }));
  d3.push(upsert("tg-2", h(11, 0, 3), "tags", "tag-focus-b", { name: "Focus", color: "#bb9af7", created_at: iso(10) }));

  // Todos: two machines claim number 1, one claims a number far above the rest, a legacy entry
  // carries `id` instead of `claimed_id`, and a raw boolean arrives in an integer column.
  d2.push(upsert("td-1", h(20, 0, 2), "todos", T(1), { title: "first claim", claimed_id: 1, created_at: iso(20), state_uuid: "state-backlog", project_uuid: "proj-a" }));
  d3.push(upsert("td-2", h(21, 0, 3), "todos", T(2), { title: "second claim on 1", claimed_id: 1, created_at: iso(21), state_uuid: "seed-state-2" }));
  d3.push(upsert("td-3", h(22, 0, 3), "todos", T(3), { title: "claims 2", claimed_id: 2, created_at: iso(22), priority: true }));
  d2.push(upsert("td-4", h(23, 0, 2), "todos", T(4), { title: "legacy id field", id: 9, created_at: iso(23) }));
  d2.push(upsert("td-5", h(24, 0, 2), "todos", T(5), { title: "child", claimed_id: 40, created_at: iso(24), parent_uuid: T(1), project_uuid: "proj-c" }));
  d3.push(upsert("td-6", h(25, 0, 3), "todos", T(6), { title: "to be deleted", claimed_id: 3, created_at: iso(25) }));
  d3.push(upsert("td-7", h(26, 0, 3), "todos", T(7), { title: "state removed under it", claimed_id: 4, created_at: iso(26), state_uuid: "state-review" }));

  // Links through an alias (label-bug-1 and label-bug-2 converge), plus a link that sorts before its todo.
  d2.push(link("lk-1", h(30, 0, 2), "todo_label_links", "link", T(1), "label-bug-2"));
  d3.push(link("lk-2", h(31, 0, 3), "todo_label_links", "link", T(2), "label-bug-1"));
  d3.push(link("lk-3", h(32, 0, 3), "todo_label_links", "unlink", T(2), "label-bug-1"));
  d3.push(link("lk-4", h(5, 0, 3), "todo_label_links", "link", T(5), "label-idea"));

  // Field LWW: a newer value wins, an older one is ignored, and a tie on (ms, counter) falls to the device number.
  d2.push(upsert("lw-1", h(40, 0, 2), "todos", T(1), { title: "first claim (d2 newer)", notes: "from d2" }));
  d3.push(upsert("lw-2", h(35, 0, 3), "todos", T(1), { title: "OLDER title from d3", notes: "older notes" }));
  d3.push(upsert("lw-3", h(41, 0, 3), "todos", T(1), { notes: "tie loses to device 3", due_date: "2026-09-01" }));
  d2.push(upsert("lw-4", h(41, 0, 2), "todos", T(1), { notes: "tie on ms and counter", due_date: "2026-09-02" }));
  d2.push(upsert("lw-5", h(42, 0, 2), "todos", T(5), { title: { value: "per-field clock wins", hlc: h(60, 0, 2) }, priority: { value: 3, hlc: h(1, 0, 2) } }));

  // Delete wins over a later edit and raises a notice; a delete of an unknown row still leaves a tombstone.
  d3.push(del("dl-1", h(50, 0, 3), "todos", T(6)));
  d2.push(upsert("dl-2", h(55, 0, 2), "todos", T(6), { title: "edit after delete" }));
  d3.push(del("dl-3", h(51, 0, 3), "todos", "never-seen-todo"));
  d3.push(del("dl-4", h(52, 0, 3), "todo_labels", "label-bug-1"));
  d3.push(del("dl-5", h(53, 0, 3), "todo_states", "state-review"));
  d3.push(del("dl-6", h(54, 0, 3), "tags", "tag-focus-b"));

  // Sessions and their tag links; a link to a session that never arrives stays deferred forever.
  d2.push(upsert("ss-1", h(60, 0, 2), "sessions", "sess-1", { title: "focus", timer_type: "work", planned_duration_seconds: 1500, actual_duration_seconds: 1490, completed_at: iso(60), issue_number: 12, issue_title: "Fix", worklog_status: "not_logged" }));
  d2.push(upsert("ss-2", h(61, 0, 2), "sessions", "sess-2", { title: "gone", timer_type: "work", planned_duration_seconds: 600, actual_duration_seconds: 600, completed_at: iso(61) }));
  d2.push(del("ss-3", h(62, 0, 2), "sessions", "sess-2"));
  d3.push(upsert("ss-4", h(63, 0, 3), "sessions", "sess-2", { title: "edit of a deleted session" }));
  d2.push(link("ss-5", h(64, 0, 2), "session_tags", "link", "sess-1", "tag-focus"));
  d2.push(link("ss-6", h(65, 0, 2), "session_tags", "link", "sess-1", "tag-focus-b"));
  d2.push(link("ss-7", h(66, 0, 2), "session_tags", "link", "sess-missing", "tag-focus"));

  // Attachments: an upsert, a duplicate of it, one for a todo that is not there, and a delete.
  const sha1 = "a".repeat(64);
  const sha2 = "b".repeat(64);
  d2.push(upsert("at-1", h(70, 0, 2), "todo_attachments", `${T(1)}:${sha1}`, { file_name: "shot.png", mime_type: "image/png", size_bytes: 1234, kind: "image" }));
  d3.push(upsert("at-2", h(71, 0, 3), "todo_attachments", `${T(1)}:${sha1}`, { file_name: "renamed.png", mime_type: "image/png", size_bytes: 99, kind: "image" }));
  d3.push(upsert("at-3", h(72, 0, 3), "todo_attachments", `no-such-todo:${sha2}`, { file_name: "orphan.txt", mime_type: "text/plain", size_bytes: 5, kind: "file" }));
  d2.push(upsert("at-4", h(73, 0, 2), "todo_attachments", `${T(5)}:${sha2}`, { file_name: "doomed.txt", size_bytes: 7 }));
  d2.push(del("at-5", h(74, 0, 2), "todo_attachments", `${T(5)}:${sha2}`));

  // A field name that is not a column is skipped; unreadable lines, future versions and unknown tables are counted.
  d3.push(upsert("bad-1", h(80, 0, 3), "todos", T(2), { "notes = 'pwned', title": "x", milestone: "M1" }));
  d3.push("this is not json");
  d3.push(JSON.stringify({ v: 2, opId: "future-1", hlc: h(81, 0, 3), table: "todos", op: "delete", rowUuid: T(2) }));
  d3.push(JSON.stringify({ v: 1, opId: "bad-table", hlc: h(82, 0, 3), table: "sqlite_master", op: "delete", rowUuid: "x" }));
  d3.push(JSON.stringify({ v: 1, opId: "bad-op", hlc: h(83, 0, 3), table: "todos", op: "truncate", rowUuid: "x" }));

  // A clock a century ahead is clamped, noticed, and still applied.
  d3.push(upsert("drift-1", hlc(FAR_FUTURE, 0, 3), "todos", T(2), { milestone: "from the future" }));

  // A deferred foreign key: the project arrives in phase 2.
  d2.push(upsert("df-1", h(90, 0, 2), "todos", T(8), { title: "waits for its project", claimed_id: 5, created_at: iso(90), project_uuid: "proj-late" }));

  // The same entry present in two peers' files: applied once.
  const dup = upsert("dup-1", h(95, 0, 2), "tags", "tag-dup", { name: "dup", color: "#7aa2f7", created_at: iso(95) });
  d2.push(dup);
  d3.push(dup);

  const phase2d2: string[] = [];
  const phase2d3: string[] = [];
  phase2d2.push(upsert("p2-1", h(100, 0, 2), "todo_projects", "proj-late", { name: "Late project", color: "#e0af68", created_at: iso(100), sync_order: "c" }));
  phase2d2.push(upsert("p2-2", h(101, 0, 2), "todos", T(7), { title: "state removed under it (edited)" }));
  phase2d3.push(upsert("p2-3", h(102, 0, 3), "todos", T(9), { title: "new in phase 2", claimed_id: 2, created_at: iso(102) }));
  phase2d3.push(link("p2-4", h(103, 0, 3), "session_tags", "link", "sess-1", "tag-dup"));
  phase2d3.push(upsert("p2-5", h(104, 0, 3), "todo_projects", "proj-a", { sync_order: "z" }));
  phase2d3.push(del("p2-6", h(105, 0, 3), "todo_projects", "proj-b"));

  return {
    name: "basics",
    phase1: { [file(D2)]: d2, [file(D3)]: d3 },
    phase2: { [file(D2)]: phase2d2, [file(D3)]: phase2d3 },
  };
}

// --- seeded fuzz: random but valid-looking entries, heavy on collisions and ties ---

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function fuzz(seed: number, entriesPerFile: number): Scenario {
  const rnd = mulberry32(seed);
  const below = (n: number): number => Math.floor(rnd() * n);
  const pick = <T>(xs: readonly T[]): T => xs[below(xs.length)]!;
  const iso = (ms: number): string => new Date(BASE + ms).toISOString();
  const uuids = (prefix: string, n: number): string[] => Array.from({ length: n }, (_, i) => `${prefix}-${i}`);

  const todoIds = uuids("fz-todo", 14);
  const labelIds = uuids("fz-label", 6);
  const tagIds = uuids("fz-tag", 5);
  const projectIds = uuids("fz-proj", 5);
  const stateIds = [...uuids("fz-state", 5), ...Array.from({ length: 6 }, (_, i) => `seed-state-${i + 1}`)];
  const sessionIds = uuids("fz-sess", 6);
  const NAMES = ["bug", "Bug", "idea", "docs", "chore", "Todo", "Backlog", "review", "focus"];

  // A row's name and creation time are fixed for its lifetime, so a later upsert can never rename it
  // onto another row's name (which would be a UNIQUE violation, the same in both engines).
  const nameOf = new Map<string, string>();
  const createdOf = new Map<string, string>();
  const SEED_LABELS = ["Backlog", "Todo", "Processing", "Testing", "Done", "Deprecated"];
  const nameFor = (uuid: string): string => {
    const seed = /^todo_states:seed-state-(\d)$/.exec(uuid);
    if (seed) return SEED_LABELS[Number(seed[1]) - 1]!;
    if (!nameOf.has(uuid)) nameOf.set(uuid, pick(NAMES));
    return nameOf.get(uuid)!;
  };
  const createdFor = (uuid: string): string => {
    if (!createdOf.has(uuid)) createdOf.set(uuid, iso(below(40) - 20));
    return createdOf.get(uuid)!;
  };

  let op = 0;
  const make = (device: string, phase: number): string => {
    op += 1;
    const dev = DEVICE_NUMBER[device]!;
    const at = hlc(BASE + phase * 100 + below(40), below(3), dev);
    const id = `fz${seed}-${op}`;
    const roll = below(100);

    if (roll < 3) return pick(["{broken", "", JSON.stringify({ v: 1, opId: `x${op}`, op: "nope", table: "todos", hlc: at })]);
    if (roll < 40) {
      const t = pick(todoIds);
      const f: Record<string, FieldSpec> = { created_at: createdFor(t) };
      if (below(2) === 0) f["title"] = `title ${below(5)}`;
      if (below(2) === 0) f["claimed_id"] = 1 + below(10);
      if (below(6) === 0) f["id"] = 1 + below(10);
      if (below(4) === 0) f["notes"] = below(2) === 0 ? null : `note ${below(4)}`;
      if (below(4) === 0) f["priority"] = below(4);
      if (below(3) === 0) f["state_uuid"] = pick(stateIds);
      if (below(4) === 0) f["project_uuid"] = below(4) === 0 ? null : pick(projectIds);
      if (below(5) === 0) f["parent_uuid"] = below(3) === 0 ? null : pick(todoIds);
      if (below(6) === 0) f["due_date"] = `2026-0${1 + below(9)}-1${below(9)}`;
      if (below(8) === 0) f["milestone"] = pick(["M1", "M2", null]);
      return upsert(id, at, "todos", t, f);
    }
    if (roll < 50) {
      const table = pick(["todo_labels", "tags", "todo_projects", "todo_states"] as const);
      const uuid = pick(table === "todo_labels" ? labelIds : table === "tags" ? tagIds : table === "todo_projects" ? projectIds : stateIds);
      const nameField = table === "todo_states" ? "label" : "name";
      const f: Record<string, FieldSpec> = { [nameField]: nameFor(`${table}:${uuid}`), created_at: createdFor(`${table}:${uuid}`) };
      if (below(2) === 0) f["color"] = pick(["#7aa2f7", "#9ece6a", "#f7768e"]);
      if ((table === "todo_projects" || table === "todo_states") && below(2) === 0) f["sync_order"] = pick(["a", "b", "c", "m", "n", "z"]);
      if (table === "todo_states" && below(3) === 0) f["is_completed"] = below(2) === 0;
      return upsert(id, at, table, uuid, f);
    }
    if (roll < 53) {
      const table = pick(["todos", "todo_labels", "tags", "todo_projects", "todo_states", "sessions"] as const);
      const pool = { todos: todoIds, todo_labels: labelIds, tags: tagIds, todo_projects: projectIds, todo_states: stateIds, sessions: sessionIds }[table];
      return del(id, at, table, pick(pool));
    }
    if (roll < 68) {
      return link(id, at, "todo_label_links", pick(["link", "unlink"] as const), pick(todoIds), pick(labelIds));
    }
    if (roll < 76) {
      return link(id, at, "session_tags", pick(["link", "unlink"] as const), pick(sessionIds), pick(tagIds));
    }
    if (roll < 88) {
      const s = pick(sessionIds);
      const f: Record<string, FieldSpec> = { completed_at: createdFor(s) };
      if (below(2) === 0) f["title"] = `session ${below(4)}`;
      if (below(2) === 0) f["timer_type"] = pick(["work", "short_break"]);
      if (below(2) === 0) f["planned_duration_seconds"] = 60 * (1 + below(30));
      if (below(2) === 0) f["actual_duration_seconds"] = 60 * (1 + below(30));
      return upsert(id, at, "sessions", s, f);
    }
    const key = `${pick(todoIds)}:${pick(["a", "b", "c"]).repeat(64)}`;
    if (roll < 94) return upsert(id, at, "todo_attachments", key, { file_name: `f${below(3)}.png`, mime_type: "image/png", size_bytes: below(5000), kind: pick(["image", "file"]) });
    return del(id, at, "todo_attachments", key);
  };

  const phase1: Record<string, string[]> = {};
  const phase2: Record<string, string[]> = {};
  for (const device of [D1, D2, D3]) {
    phase1[file(device)] = Array.from({ length: entriesPerFile }, () => make(device, 1));
    phase2[file(device)] = Array.from({ length: Math.floor(entriesPerFile / 2) }, () => make(device, 2));
  }
  return { name: `fuzz-${seed}`, phase1, phase2 };
}

export function makeScenarios(fuzzSeeds: number[] = [1, 2, 3, 4, 5, 6], entriesPerFile = 120): Scenario[] {
  return [basics(), ...fuzzSeeds.map((s) => fuzz(s, entriesPerFile))];
}
