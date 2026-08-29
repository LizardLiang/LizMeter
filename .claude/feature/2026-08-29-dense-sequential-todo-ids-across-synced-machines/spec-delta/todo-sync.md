## ADDED Requirements

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

The system SHALL resolve a todo id claimed by two different rows by keeping the number for the row created earlier by hybrid-logical-clock order and reassigning the later row to an unused number, so that two machines creating todos while apart converge without either row being lost.

#### Scenario: Concurrent creation on two machines

- **WHEN** machine A and machine B each create a todo claiming id 43 while unable to see each other, and A's todo has the earlier creation clock
- **THEN** A's todo keeps id 43 and B's todo is reassigned to an unused number on both machines

#### Scenario: A batch of collisions after a long offline period

- **WHEN** a machine that created 5 todos offline merges with a peer that used all 5 of those numbers
- **THEN** all 5 local todos are reassigned to unused numbers and no todo is dropped or merged into another

### Requirement: Todo id reassignment is published

The system SHALL record a todo id reassignment as a synced field change, so that the device that originally issued the number learns the todo has moved instead of permanently disagreeing with its peer.

#### Scenario: The losing device learns its todo moved

- **WHEN** one machine reassigns a todo's id during a merge and later syncs with the machine that created it
- **THEN** both machines report the same id for that todo

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
