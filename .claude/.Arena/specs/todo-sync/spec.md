---
created: 2026-08-29T23:27:44+08:00
updated: 2026-11-11T13:37:33+08:00
author: athena
git_hash: 9d09507
capability: todo-sync
---

# Todo Sync

## Purpose

Keeps todos consistent across a person's machines, which share state through a cloud-drive folder
rather than a server. Each machine writes only its own append-only oplog file; no machine ever sees
a peer's write synchronously, so nothing can be locked, reserved, or agreed upon in advance.

This capability covers the part of that problem where a todo's **number** is user-facing. Unlike
every other synced table, whose local ids are device-private, a todo's id is the handle people
reference it by — in notes, and through the MCP tools — so it must be small, sequential, and mean
the same thing on every machine. Those goals conflict: two machines working apart will inevitably
issue the same number, and a number already referenced must not silently come to mean a different
todo.

The resolution is to derive rather than negotiate. Machines publish only the number they issued;
each machine computes the resolved assignment itself from the complete set of claims. Identical
inputs give identical output, so agreement needs no exchange — which matters because the transport
cannot support one.

## Requirements

### Requirement: Dense sequential todo id allocation

The system SHALL assign every new todo the next unused integer from a persisted per-device high-water mark, so that todo ids remain small and sequential on every machine whether or not sync is enabled.

#### Scenario: Creating a todo on a synced machine

- **WHEN** a todo is created on a machine with sync enabled and the highest id ever issued locally is 42
- **THEN** the new todo receives id 43, not a device-block-offset value

#### Scenario: The high-water mark never reuses a number

- **WHEN** the todo holding the highest id is deleted and a new todo is then created
- **THEN** the new todo receives an id above the deleted one, never the deleted todo's number

### Requirement: Todo id high-water mark advances on merge

The system SHALL raise this device's todo id high-water mark past the highest todo id observed in any peer's merged entries, so that a device returning from an offline period stops issuing numbers its peer has already used.

#### Scenario: Returning from an offline period

- **WHEN** a merge pass applies peer entries whose highest todo id is 73 and this device's high-water mark is 44
- **THEN** the next todo created on this device receives id 74

### Requirement: Todo id collision resolution at merge

The system SHALL derive every todo's visible id from the complete set of claims, giving each number to its earliest-created claimant and placing any later claimant of an already-taken number after the highest claim, so that two machines creating todos while apart converge without either row being lost. Claimants are ordered by creation time, with the row uuid as a tie-break.

#### Scenario: Concurrent creation on two machines

- **WHEN** machine A and machine B each create a todo claiming id 43 while unable to see each other, and A's todo was created first
- **THEN** A's todo holds id 43 and B's todo holds an unused number, identically on both machines

#### Scenario: A batch of collisions after a long offline period

- **WHEN** a machine that created 5 todos offline merges with a peer that used all 5 of those numbers
- **THEN** all 5 todos hold unused numbers and no todo is dropped or merged into another

#### Scenario: An uncontested number never moves

- **WHEN** a todo's claimed number is claimed by no other todo, across any number of merge passes
- **THEN** it keeps that number permanently

### Requirement: Todo numbers converge without negotiation

The system SHALL publish only the number a machine issued for a todo, never the resolved id, and SHALL treat that claim as immutable. Each machine derives the resolved assignment independently, so machines holding the same todos agree without exchanging anything about the resolution.

Deriving rather than negotiating is load-bearing, not stylistic: an earlier design had each machine pick a replacement number from its own counter and publish it as a last-write-wins field, which never converged, because a machine's own write always carries a newer clock than its peer's and each side therefore permanently rejected the other's answer.

#### Scenario: Both machines reach the same assignment

- **WHEN** two machines that created todos while apart have each merged the other's changes
- **THEN** both report the same number for every todo

#### Scenario: The assignment is stable once reached

- **WHEN** further merge passes run after both machines agree
- **THEN** no todo's number changes

### Requirement: Referential integrity across a todo id change

The system SHALL preserve every reference to a todo when its id changes, covering sub-todo parentage, label links, and attachments.

#### Scenario: A reassigned todo keeps its relationships

- **WHEN** a todo with a parent, two labels, and one attachment is reassigned a new id
- **THEN** its parent link, both label links, and its attachment still resolve to that todo

### Requirement: One-time renumber of block-allocated todo ids

The system SHALL provide a user-initiated migration that reassigns every block-allocated todo id into the dense sequence, preserving the ids of todos that were never block-allocated and ordering the reassigned todos by creation time.

#### Scenario: Renumbering a second machine's todos

- **WHEN** the migration runs on a database whose highest non-block id is 120 and which holds 3 block-allocated todos
- **THEN** those 3 todos receive ids 121, 122, and 123 in creation order, and no todo with an id at or below 120 changes

#### Scenario: The migration is confirm-gated and backed up

- **WHEN** the user requests the renumber from Settings
- **THEN** the app refuses until the user confirms, and writes a timestamped database backup before making any change

#### Scenario: Re-running the migration is a no-op

- **WHEN** the migration runs a second time on an already-renumbered database
- **THEN** no todo id changes

### Requirement: Todo id reassignment is reported

The system SHALL record a sync notice naming each todo whose id changed during a merge, without raising a desktop notification.

#### Scenario: A bump is visible in Settings

- **WHEN** a merge pass reassigns two todos' ids
- **THEN** a sync notice lists both the old and the new id for each, and no OS notification is shown

### Requirement: MCP writes reject a stale todo id

The system SHALL refuse an MCP write that names a todo id whose identity no longer matches the one the caller listed, so that a reassignment between listing and writing cannot silently edit the wrong todo.

#### Scenario: Writing to a reassigned id

- **WHEN** a caller lists todos, a merge then reassigns ids, and the caller updates a todo by an id that now belongs to a different todo
- **THEN** the write is refused with an error directing the caller to list again, and no todo is modified

#### Scenario: Writing to an unchanged id

- **WHEN** a caller lists todos and updates one by id with no reassignment in between
- **THEN** the write succeeds

### Requirement: Oplog lines publish only after commit

The system SHALL write a synced change's oplog line to the device's oplog file only after the SQL transaction that made the change has committed.

#### Scenario: A write fails after its record call

- **WHEN** a todo create records its upsert and a later step in the same transaction fails
- **THEN** the transaction rolls back and no line for that todo reaches the oplog file

### Requirement: Every committed change is published

The system SHALL keep each committed change's oplog line in a local outbox until it has been appended to the oplog file, and SHALL retry after commit, at startup, every 30 seconds while lines are pending, before trimming its own oplog, and on quit.

#### Scenario: Shared folder unreachable

- **WHEN** the user edits a todo while the sync folder cannot be written
- **THEN** the edit is saved locally, the line stays pending, and it is appended in order once the folder can be written again

### Requirement: A repeated publish is harmless

The system SHALL tolerate the same oplog line appearing twice in a device's file, applying it once on every peer.

#### Scenario: Crash between append and outbox cleanup

- **WHEN** the app stops after appending pending lines but before removing them from the outbox
- **THEN** the next start appends them again and each peer applies every opId only once

### Requirement: Deletes publish with the delete

The system SHALL record a delete's tombstone in the same transaction as the row delete.

#### Scenario: Crash right after a delete

- **WHEN** the app stops right after a todo delete commits
- **THEN** the tombstone line is published at the next start and peers delete the todo

### Requirement: First sync publish resumes after a crash

The system SHALL turn sync on and queue the publish of existing rows in one transaction.

#### Scenario: Crash while enabling sync

- **WHEN** the app stops while publishing existing rows for the first time
- **THEN** either sync is still off with nothing queued, or every row is published at the next start

### Requirement: Publish failure keeps the local edit

The system SHALL NOT fail a local write because its oplog line could not be appended, and SHALL show one sync notice with the count of pending changes until they are published.

#### Scenario: Notice clears after recovery

- **WHEN** pending lines are appended successfully
- **THEN** the pending-publish notice disappears

### Requirement: Outbox is local and identical in both engines

The system SHALL store pending lines in a local-only table `sync_outbox` with the same schema in the Electron and native engines, never publishing that table itself.

#### Scenario: Schema equality

- **WHEN** a fresh and an upgraded database are dumped by both engines
- **THEN** both contain the same `sync_outbox` definition and the snapshot contains no outbox rows
