# Effects coverage: Electron CSS to native

Written in phase 11, part B. Native app: `native/crates/app`, `native/crates/ui`. Reference: the Electron build (`src/renderer/**/*.module.scss`, `global.scss`, `index.html`).

## Recount

The plan counted 178 `backdrop-filter` rules and 14 `@keyframes`. A fresh grep gives these numbers.

| What | Plan | Real | Why |
|---|---|---|---|
| `backdrop-filter` declarations | 178 | **91** (89 `blur(...)`, 2 `none`) | The plan counted the `-webkit-backdrop-filter` twin of each rule too: 91 + 87 prefixed twins = 178. |
| `@keyframes` blocks | 14 | **13 blocks, 8 distinct animations** | `spin` x5, `fadeIn` x2, `modalEntrance` x2 are copies of one animation each. |

Scripts: the rule list comes from a brace-aware scan of every `*.module.scss` plus `index.html` (scratchpad `phase11b/rules.py`). A second script (`audit.py`) checks that each rule's (blur, saturate) pair is drawn by the native file mapped to it.

## Readability rule for dialogs

Every dialog overlay in the native app is `blur(28px) saturate(1.25)` with a 10 % tint (`modal_overlay`, `modal.rs`, `md_editor.rs`, `rich_input.rs`). Electron uses `blur(16px)`: the page behind a dialog keeps shapes you can half read, which the user called too transparent. The dialog itself uses the opaque formula `dialog_glass` (36 px / 1.7, fill `rgba(20,23,42,.86)`). Before 11B the overlays of the Todos dialogs, the shortcuts sheet and the notes modal still used 16 px; 11B moved them to 28 px. Overlay rows below are marked `deliberate`.

## Summary

| Status | Rules |
|---|---|
| match | 75 |
| deliberate (dialog overlay 28 px, readability rule) | 12 |
| none (no blur in Electron: bare/fill editor) | 2 |
| not rendered (`Sidebar.module.scss`, the component is dead code) | 1 |
| part A (desktop widget) | 1 |

No rule is left without a native counterpart. Evidence paths are relative to the session scratchpad, `phase11b/` (PNGs are not committed). `sbs/*.png` puts Electron on the left and native on the right (native window includes the 8 px frame, so the widths differ by 16 px).

## backdrop-filter rules (91)

| # | Rule (file:line) | Selector | Value | Native location | Evidence | Status |
|---|---|---|---|---|---|---|
| 1 | `index.html:33` | `#titlebar` | `blur(28px) saturate(1.7)` | crates/app/src/chrome.rs `titlebar_glass` | phase11b/sbs/todos.png | match |
| 2 | `src/components/ActivityPage.module.scss:29` | `.navBtn` | `blur(8px)` | crates/app/src/pages/activity.rs, `controls::card_glass` | phase11b/sbs/activity.png | match |
| 3 | `src/components/ActivityPage.module.scss:86` | `.projectGroup` | `blur(24px) saturate(1.5)` | crates/app/src/pages/activity.rs, `controls::card_glass` | phase11b/sbs/activity.png | match |
| 4 | `src/components/Combobox.module.scss:11` | `.wrap` | `blur(8px)` | crates/app/src/pages/todo_widgets.rs `trigger_frame` | phase11b/sbs/todos-new.png | match |
| 5 | `src/components/DatePicker.module.scss:18` | `.panel` | `blur(32px) saturate(1.6)` | crates/app/src/pages/todo_fields.rs panel via `list_surface`-class glass 32 px | phase11b/sbs/todo-detail.png | match |
| 6 | `src/components/HistoryPage.module.scss:28` | `.chip` | `blur(8px)` | crates/app/src/pages/history.rs, `controls::card_glass` | phase11b/sbs/history.png | match |
| 7 | `src/components/HistoryPage.module.scss:93` | `.loadMoreBtn` | `blur(8px)` | crates/app/src/pages/history.rs, `controls::card_glass` | phase11b/sbs/history.png | match |
| 8 | `src/components/HistoryPage.module.scss:186` | `.card` | `blur(24px) saturate(1.5)` | crates/app/src/pages/history.rs, `controls::card_glass` | phase11b/sbs/history.png | match |
| 9 | `src/components/IssuePickerDropdown.module.scss:16` | `.linkBtn` | `blur(8px)` | crates/app/src/modal.rs (link button, dropdown) | phase11b/sbs/timer.png | match |
| 10 | `src/components/IssuePickerDropdown.module.scss:83` | `.dropdown` | `blur(28px) saturate(1.6)` | crates/app/src/modal.rs (link button, dropdown) | phase11b/sbs/timer.png | match |
| 11 | `src/components/IssuePromptDialog.module.scss:7` | `.overlay` | `blur(16px) saturate(1.25)` | crates/app/src/modal.rs `dialog` 36/1.7 + overlay | phase11b/n/modal.png (native only: Electron prompt needs a typed title, compared in 6c) | deliberate (overlay is 28 px / 1.25 + 10% tint (CSS 16 px): the page behind must be a frosted wash with no readable shapes) |
| 12 | `src/components/IssuePromptDialog.module.scss:22` | `.dialog` | `blur(36px) saturate(1.7)` | crates/app/src/modal.rs `dialog` 36/1.7 + overlay | phase11b/n/modal.png (native only: Electron prompt needs a typed title, compared in 6c) | match |
| 13 | `src/components/IssuesPage.module.scss:132` | `.card` | `blur(24px) saturate(1.5)` | crates/app/src/pages/issues.rs | phase11b/sbs/issues.png | match |
| 14 | `src/components/IssuesPage.module.scss:221` | `.searchInput` | `blur(8px)` | crates/app/src/pages/issues.rs | phase11b/sbs/issues.png | match |
| 15 | `src/components/IssuesPage.module.scss:369` | `.comment` | `blur(8px)` | crates/app/src/pages/issues.rs | phase11b/sbs/issues.png | match |
| 16 | `src/components/MarkdownEditor.module.scss:19` | `.wrapper :global(.cm-editor)` | `blur(8px)` | crates/ui/src/md_editor.rs (Framed 8 px, Bare/Fill none, modal 36/1.7) | phase11b/n/notes-modal.png (Electron: phase1/rich-modal.png) | match |
| 17 | `src/components/MarkdownEditor.module.scss:366` | `.wrapperBare :global(.cm-editor)` | `none` | crates/ui/src/md_editor.rs (Framed 8 px, Bare/Fill none, modal 36/1.7) | phase11b/n/notes-modal.png (Electron: phase1/rich-modal.png) | none (no blur in Electron either (bare/fill editor)) |
| 18 | `src/components/MarkdownEditor.module.scss:419` | `.wrapperFill :global(.cm-editor)` | `none` | crates/ui/src/md_editor.rs (Framed 8 px, Bare/Fill none, modal 36/1.7) | phase11b/n/notes-modal.png (Electron: phase1/rich-modal.png) | none (no blur in Electron either (bare/fill editor)) |
| 19 | `src/components/MarkdownEditor.module.scss:486` | `.dropHint` | `blur(8px)` | crates/ui/src/md_editor.rs (Framed 8 px, Bare/Fill none, modal 36/1.7) | phase11b/n/notes-modal.png (Electron: phase1/rich-modal.png) | match |
| 20 | `src/components/MarkdownEditor.module.scss:524` | `.modalBackdrop` | `blur(16px) saturate(1.25)` | crates/ui/src/md_editor.rs (Framed 8 px, Bare/Fill none, modal 36/1.7) | phase11b/n/notes-modal.png (Electron: phase1/rich-modal.png) | deliberate (overlay is 28 px / 1.25 + 10% tint (CSS 16 px): the page behind must be a frosted wash with no readable shapes) |
| 21 | `src/components/MarkdownEditor.module.scss:539` | `.modalCard` | `blur(36px) saturate(1.7)` | crates/ui/src/md_editor.rs (Framed 8 px, Bare/Fill none, modal 36/1.7) | phase11b/n/notes-modal.png (Electron: phase1/rich-modal.png) | match |
| 22 | `src/components/ModeToggle.module.scss:7` | `.container` | `blur(20px) saturate(1.5)` | crates/app/src/timer.rs `mode_toggle` 20/1.5 | phase11b/sbs/timer.png | match |
| 23 | `src/components/NavSidebar.module.scss:11` | `.sidebar` | `blur(28px) saturate(1.7)` | crates/app/src/chrome.rs `sidebar_glass` / hover tip `Glass` 12 px | phase11b/sbs/todos.png | match |
| 24 | `src/components/NavSidebar.module.scss:50` | `.btn &::before` | `blur(12px)` | crates/app/src/chrome.rs `sidebar_glass` / hover tip `Glass` 12 px | phase11b/sbs/todos.png | match |
| 25 | `src/components/RichTextInput.module.scss:10` | `.wrapper` | `blur(12px)` | crates/ui/src/rich_input.rs (wrapper 12 px, modal 36/1.7) | phase11b/sbs/timer.png | match |
| 26 | `src/components/RichTextInput.module.scss:263` | `.modalBackdrop` | `blur(16px) saturate(1.25)` | crates/ui/src/rich_input.rs (wrapper 12 px, modal 36/1.7) | phase11b/sbs/timer.png | deliberate (overlay is 28 px / 1.25 + 10% tint (CSS 16 px): the page behind must be a frosted wash with no readable shapes) |
| 27 | `src/components/RichTextInput.module.scss:278` | `.modalCard` | `blur(36px) saturate(1.7)` | crates/ui/src/rich_input.rs (wrapper 12 px, modal 36/1.7) | phase11b/sbs/timer.png | match |
| 28 | `src/components/Select.module.scss:13` | `.trigger` | `blur(8px)` | crates/app/src/select.rs (trigger 8 px, list 32/1.6) | phase11b/sbs/todos.png | match |
| 29 | `src/components/Select.module.scss:66` | `.list` | `blur(32px) saturate(1.6)` | crates/app/src/select.rs (trigger 8 px, list 32/1.6) | phase11b/sbs/todos.png | match |
| 30 | `src/components/SettingsPage.module.scss:115` | `.input` | `blur(8px)` | crates/app/src/pages/settings_ui.rs, settings_sections.rs, controls.rs `glass_field` | phase11b/sbs/settings.png | match |
| 31 | `src/components/SettingsPage.module.scss:277` | `.tokenInput` | `blur(8px)` | crates/app/src/pages/settings_ui.rs, settings_sections.rs, controls.rs `glass_field` | phase11b/sbs/settings.png | match |
| 32 | `src/components/SettingsPage.module.scss:303` | `.segmentedControl` | `blur(8px)` | crates/app/src/pages/settings_ui.rs, settings_sections.rs, controls.rs `glass_field` | phase11b/sbs/settings.png | match |
| 33 | `src/components/SettingsPage.module.scss:358` | `.teamOption` | `blur(8px)` | crates/app/src/pages/settings_ui.rs, settings_sections.rs, controls.rs `glass_field` | phase11b/sbs/settings.png | match |
| 34 | `src/components/Sidebar.module.scss:6` | `.sidebar` | `blur(24px) saturate(1.6)` | none: `Sidebar.tsx` is not imported by any component (dead code in Electron) | - | not rendered (Electron never mounts it) |
| 35 | `src/components/StatsPage.module.scss:25` | `.range` | `blur(8px)` | crates/app/src/pages/stats.rs, `controls::card_glass` | phase11b/sbs/stats.png | match |
| 36 | `src/components/StatsPage.module.scss:68` | `.summaryCard` | `blur(24px) saturate(1.5)` | crates/app/src/pages/stats.rs, `controls::card_glass` | phase11b/sbs/stats.png | match |
| 37 | `src/components/StopwatchView.module.scss:11` | `.container` | `blur(32px) saturate(1.6)` | crates/app/src/cards.rs / timer.rs `card_glass` 32/1.6 | phase11b/sbs/stopwatch.png | match |
| 38 | `src/components/TagManager.module.scss:26` | `.input` | `blur(8px)` | crates/app/src/pages/tags.rs | phase11b/sbs/tags.png | match |
| 39 | `src/components/TagManager.module.scss:80` | `.tagRow` | `blur(8px)` | crates/app/src/pages/tags.rs | phase11b/sbs/tags.png | match |
| 40 | `src/components/TagPicker.module.scss:30` | `.dropdown` | `blur(24px) saturate(1.6)` | crates/app/src/tag_picker.rs 24 px dropdown | phase11b/sbs/timer.png | match |
| 41 | `src/components/TimerView.module.scss:9` | `.container` | `blur(32px) saturate(1.6)` | crates/app/src/timer.rs `card_glass` 32/1.6, error banner 8 px | phase11b/sbs/timer.png | match |
| 42 | `src/components/TimerView.module.scss:80` | `.error` | `blur(8px)` | crates/app/src/timer.rs `card_glass` 32/1.6, error banner 8 px | phase11b/sbs/timer.png | match |
| 43 | `src/components/TodoAttachments.module.scss:82` | `.tile` | `blur(8px)` | crates/app/src/pages/todo_attachments.rs `.backdrop_filter(8)` | phase11b/sbs/todo-detail.png | match |
| 44 | `src/components/TodoDetailPage.module.scss:124` | `.overflowMenu` | `blur(28px) saturate(1.6)` | crates/app/src/pages/todo_detail.rs (overflow menu 28/1.6, rail 24/1.5, inputs 8) | phase11b/sbs/todo-detail.png | match |
| 45 | `src/components/TodoDetailPage.module.scss:219` | `.rail` | `blur(24px) saturate(1.5)` | crates/app/src/pages/todo_detail.rs (overflow menu 28/1.6, rail 24/1.5, inputs 8) | phase11b/sbs/todo-detail.png | match |
| 46 | `src/components/TodoDetailPage.module.scss:517` | `.input` | `blur(8px)` | crates/app/src/pages/todo_detail.rs (overflow menu 28/1.6, rail 24/1.5, inputs 8) | phase11b/sbs/todo-detail.png | match |
| 47 | `src/components/TodoDetailPage.module.scss:581` | `.labelRow` | `blur(8px)` | crates/app/src/pages/todo_detail.rs (overflow menu 28/1.6, rail 24/1.5, inputs 8) | phase11b/sbs/todo-detail.png | match |
| 48 | `src/components/TodoEditDialog.module.scss:11` | `.overlay` | `blur(16px) saturate(1.25)` | crates/app/src/pages/todo_edit.rs, `dialog_glass` + `modal_overlay` | phase11b/sbs/todos-new.png | deliberate (overlay is 28 px / 1.25 + 10% tint (CSS 16 px): the page behind must be a frosted wash with no readable shapes) |
| 49 | `src/components/TodoEditDialog.module.scss:26` | `.dialog` | `blur(36px) saturate(1.7)` | crates/app/src/pages/todo_edit.rs, `dialog_glass` + `modal_overlay` | phase11b/sbs/todos-new.png | match |
| 50 | `src/components/TodoEditDialog.module.scss:87` | `.labelRow` | `blur(8px)` | crates/app/src/pages/todo_edit.rs, `dialog_glass` + `modal_overlay` | phase11b/sbs/todos-new.png | match |
| 51 | `src/components/TodoEditDialog.module.scss:164` | `.input` | `blur(8px)` | crates/app/src/pages/todo_edit.rs, `dialog_glass` + `modal_overlay` | phase11b/sbs/todos-new.png | match |
| 52 | `src/components/TodoPicker.module.scss:12` | `.overlay` | `blur(16px) saturate(1.25)` | crates/app/src/pages/todo_picker.rs, `dialog_glass` + `modal_overlay` | phase11b/sbs/todos-new.png | deliberate (overlay is 28 px / 1.25 + 10% tint (CSS 16 px): the page behind must be a frosted wash with no readable shapes) |
| 53 | `src/components/TodoPicker.module.scss:25` | `.dialog` | `blur(36px) saturate(1.7)` | crates/app/src/pages/todo_picker.rs, `dialog_glass` + `modal_overlay` | phase11b/sbs/todos-new.png | match |
| 54 | `src/components/TodoPicker.module.scss:48` | `.search` | `blur(8px)` | crates/app/src/pages/todo_picker.rs, `dialog_glass` + `modal_overlay` | phase11b/sbs/todos-new.png | match |
| 55 | `src/components/TodoQuickMenu.module.scss:20` | `.menu` | `blur(36px) saturate(1.7)` | crates/app/src/pages/todos_menus.rs quick menu 36/1.7 | phase11b/sbs/todos-quick.png | match |
| 56 | `src/components/TodoQuickMenu.module.scss:43` | `.search` | `blur(8px)` | crates/app/src/pages/todos_menus.rs quick menu 36/1.7 | phase11b/sbs/todos-quick.png | match |
| 57 | `src/components/TodoRowMenu.module.scss:11` | `.menu` | `blur(36px) saturate(1.7)` | crates/app/src/pages/todos_menus.rs action menu 36/1.7 | phase11b/sbs/todos-menu.png | match |
| 58 | `src/components/TodoShortcutsOverlay.module.scss:12` | `.overlay` | `blur(16px) saturate(1.25)` | crates/app/src/pages/todos_menus.rs `shortcuts_overlay`, `dialog_glass` + `modal_overlay` | phase11b/sbs/todos-shortcuts.png | deliberate (overlay is 28 px / 1.25 + 10% tint (CSS 16 px): the page behind must be a frosted wash with no readable shapes) |
| 59 | `src/components/TodoShortcutsOverlay.module.scss:27` | `.dialog` | `blur(36px) saturate(1.7)` | crates/app/src/pages/todos_menus.rs `shortcuts_overlay`, `dialog_glass` + `modal_overlay` | phase11b/sbs/todos-shortcuts.png | match |
| 60 | `src/components/TodoStateManager.module.scss:11` | `.overlay` | `blur(16px) saturate(1.25)` | crates/app/src/pages/todo_manage.rs, `dialog_glass` + `modal_overlay` | phase11b/sbs/todos-manage.png | deliberate (overlay is 28 px / 1.25 + 10% tint (CSS 16 px): the page behind must be a frosted wash with no readable shapes) |
| 61 | `src/components/TodoStateManager.module.scss:26` | `.dialog` | `blur(36px) saturate(1.7)` | crates/app/src/pages/todo_manage.rs, `dialog_glass` + `modal_overlay` | phase11b/sbs/todos-manage.png | match |
| 62 | `src/components/TodoStateManager.module.scss:56` | `.tabs` | `blur(8px)` | crates/app/src/pages/todo_manage.rs, `dialog_glass` + `modal_overlay` | phase11b/sbs/todos-manage.png | match |
| 63 | `src/components/TodosPage.module.scss:138` | `.panel` | `blur(24px) saturate(1.5)` | crates/app/src/pages/todos.rs (panel 24/1.5, bulk bar 36/1.7, ghost 18/1.5, copy pill 24/1.5) | phase11b/sbs/todos.png | match |
| 64 | `src/components/TodosPage.module.scss:597` | `.bulkBar` | `blur(36px) saturate(1.7)` | crates/app/src/pages/todos.rs (panel 24/1.5, bulk bar 36/1.7, ghost 18/1.5, copy pill 24/1.5) | phase11b/sbs/todos.png | match |
| 65 | `src/components/TodosPage.module.scss:701` | `.ghost` | `blur(18px) saturate(1.5)` | crates/app/src/pages/todos.rs (panel 24/1.5, bulk bar 36/1.7, ghost 18/1.5, copy pill 24/1.5) | phase11b/sbs/todos.png | match |
| 66 | `src/components/TodosPage.module.scss:740` | `.copyPill` | `blur(24px) saturate(1.5)` | crates/app/src/pages/todos.rs (panel 24/1.5, bulk bar 36/1.7, ghost 18/1.5, copy pill 24/1.5) | phase11b/sbs/todos.png | match |
| 67 | `src/components/WorklogConfirmDialog.module.scss:5` | `.overlay` | `blur(16px) saturate(1.25)` | crates/app/src/pages/worklog_dialog.rs, `dialog_glass` + `modal_overlay` | phase11b/n/history-worklog.png (native; Electron pair from 8: scratchpad/phase8/sbs-wl-ok.png) | deliberate (overlay is 28 px / 1.25 + 10% tint (CSS 16 px): the page behind must be a frosted wash with no readable shapes) |
| 68 | `src/components/WorklogConfirmDialog.module.scss:19` | `.dialog` | `blur(36px) saturate(1.7)` | crates/app/src/pages/worklog_dialog.rs, `dialog_glass` + `modal_overlay` | phase11b/n/history-worklog.png (native; Electron pair from 8: scratchpad/phase8/sbs-wl-ok.png) | match |
| 69 | `src/components/WorklogConfirmDialog.module.scss:74` | `.input` | `blur(8px)` | crates/app/src/pages/worklog_dialog.rs, `dialog_glass` + `modal_overlay` | phase11b/n/history-worklog.png (native; Electron pair from 8: scratchpad/phase8/sbs-wl-ok.png) | match |
| 70 | `src/components/music/BinaryConsentDialog.module.scss:5` | `.overlay` | `blur(16px) saturate(1.25)` | crates/app/src/pages/music_consent.rs, `dialog_glass` + `modal_overlay` | phase11b/sbs/music-consent.png (Electron: phase9b/epng/e-consent.png) | deliberate (overlay is 28 px / 1.25 + 10% tint (CSS 16 px): the page behind must be a frosted wash with no readable shapes) |
| 71 | `src/components/music/BinaryConsentDialog.module.scss:19` | `.dialog` | `blur(36px) saturate(1.7)` | crates/app/src/pages/music_consent.rs, `dialog_glass` + `modal_overlay` | phase11b/sbs/music-consent.png (Electron: phase9b/epng/e-consent.png) | match |
| 72 | `src/components/music/BinaryConsentDialog.module.scss:82` | `.binaryRow` | `blur(8px)` | crates/app/src/pages/music_consent.rs, `dialog_glass` + `modal_overlay` | phase11b/sbs/music-consent.png (Electron: phase9b/epng/e-consent.png) | match |
| 73 | `src/components/music/BinaryConsentDialog.module.scss:153` | `.storageValue` | `blur(8px)` | crates/app/src/pages/music_consent.rs, `dialog_glass` + `modal_overlay` | phase11b/sbs/music-consent.png (Electron: phase9b/epng/e-consent.png) | match |
| 74 | `src/components/music/LibraryView.module.scss:18` | `.searchWrapper` | `blur(8px)` | crates/app/src/pages/music_library.rs, music_menu.rs clear dialog | phase11b/sbs/music-clear.png (Electron: phase9b/epng/e-clear.png) | match |
| 75 | `src/components/music/LibraryView.module.scss:409` | `.integrityPanel` | `blur(8px)` | crates/app/src/pages/music_library.rs, music_menu.rs clear dialog | phase11b/sbs/music-clear.png (Electron: phase9b/epng/e-clear.png) | match |
| 76 | `src/components/music/LibraryView.module.scss:621` | `.clearOverlay` | `blur(16px) saturate(1.25)` | crates/app/src/pages/music_library.rs, music_menu.rs clear dialog | phase11b/sbs/music-clear.png (Electron: phase9b/epng/e-clear.png) | deliberate (overlay is 28 px / 1.25 + 10% tint (CSS 16 px): the page behind must be a frosted wash with no readable shapes) |
| 77 | `src/components/music/LibraryView.module.scss:633` | `.clearDialog` | `blur(36px) saturate(1.7)` | crates/app/src/pages/music_library.rs, music_menu.rs clear dialog | phase11b/sbs/music-clear.png (Electron: phase9b/epng/e-clear.png) | match |
| 78 | `src/components/music/MusicBottomBar.module.scss:23` | `.bar` | `blur(24px) saturate(1.5)` | crates/app/src/pages/music_bar.rs `Glass` 24/1.5 | phase11b/sbs/music.png | match |
| 79 | `src/components/music/MusicPage.module.scss:24` | `.setupBanner` | `blur(8px)` | crates/app/src/pages/music.rs (banner, url field, tab bar, tab content 20/1.4, toast 12 px) | phase11b/sbs/music.png | match |
| 80 | `src/components/music/MusicPage.module.scss:64` | `.urlInputWrapper` | `blur(8px)` | crates/app/src/pages/music.rs (banner, url field, tab bar, tab content 20/1.4, toast 12 px) | phase11b/sbs/music.png | match |
| 81 | `src/components/music/MusicPage.module.scss:202` | `.tabBar` | `blur(8px)` | crates/app/src/pages/music.rs (banner, url field, tab bar, tab content 20/1.4, toast 12 px) | phase11b/sbs/music.png | match |
| 82 | `src/components/music/MusicPage.module.scss:250` | `.tabContent` | `blur(20px) saturate(1.4)` | crates/app/src/pages/music.rs (banner, url field, tab bar, tab content 20/1.4, toast 12 px) | phase11b/sbs/music.png | match |
| 83 | `src/components/music/MusicPage.module.scss:308` | `.toast` | `blur(12px)` | crates/app/src/pages/music.rs (banner, url field, tab bar, tab content 20/1.4, toast 12 px) | phase11b/sbs/music.png | match |
| 84 | `src/components/music/PlaylistManager.module.scss:396` | `.addUrlInput` | `blur(8px)` | crates/app/src/pages/music_playlists.rs, delete dialog via `modal_overlay` | phase11b/sbs/music.png | match |
| 85 | `src/components/music/PlaylistManager.module.scss:555` | `.deleteOverlay` | `blur(16px) saturate(1.25)` | crates/app/src/pages/music_playlists.rs, delete dialog via `modal_overlay` | phase11b/sbs/music.png | deliberate (overlay is 28 px / 1.25 + 10% tint (CSS 16 px): the page behind must be a frosted wash with no readable shapes) |
| 86 | `src/components/music/PlaylistManager.module.scss:567` | `.deleteDialog` | `blur(36px) saturate(1.7)` | crates/app/src/pages/music_playlists.rs, delete dialog via `modal_overlay` | phase11b/sbs/music.png | match |
| 87 | `src/components/music/TrackContextMenu.module.scss:37` | `.menu` | `blur(24px) saturate(1.6)` | crates/app/src/pages/music_menu.rs `popup_glass` 24/1.6, delete dialog | phase11b/n/music-menu.png (Electron: phase9b/epng/e-menu-sub.png) | match |
| 88 | `src/components/music/TrackContextMenu.module.scss:134` | `.submenu` | `blur(24px) saturate(1.6)` | crates/app/src/pages/music_menu.rs `popup_glass` 24/1.6, delete dialog | phase11b/n/music-menu.png (Electron: phase9b/epng/e-menu-sub.png) | match |
| 89 | `src/components/music/TrackContextMenu.module.scss:160` | `.deleteOverlay` | `blur(16px) saturate(1.25)` | crates/app/src/pages/music_menu.rs `popup_glass` 24/1.6, delete dialog | phase11b/n/music-menu.png (Electron: phase9b/epng/e-menu-sub.png) | deliberate (overlay is 28 px / 1.25 + 10% tint (CSS 16 px): the page behind must be a frosted wash with no readable shapes) |
| 90 | `src/components/music/TrackContextMenu.module.scss:172` | `.deleteDialog` | `blur(36px) saturate(1.7)` | crates/app/src/pages/music_menu.rs `popup_glass` 24/1.6, delete dialog | phase11b/n/music-menu.png (Electron: phase9b/epng/e-menu-sub.png) | match |
| 91 | `widget/Widget.module.scss:37` | `.widget` | `blur(28px) saturate(1.4)` | crates/app/src/widget.rs `Glass` 28/1.4 chamfered (phase 11 part A) | - | part A (desktop widget, proved by part A) |

## @keyframes (13 blocks, 8 distinct)

Strips: `phase11b/sbs/keyframes-strip.png`. Each animation has two rows of five frames (0, 25, 50, 75, 100 % of its duration), Electron on top (`tools/anim.html` driven over CDP) and native below (`--page anim:<name> --anim-time <ms>`). Frames match for all eight.

| Keyframes | Timing | Electron use | Native location | Status |
|---|---|---|---|---|
| `spin` | 0.7 s linear infinite | BinaryConsentDialog:274, LibraryView:227 + :394, MusicPage:148, PlaylistManager:705 (0.7 s); MusicBottomBar:223 (1 s) | pages/music.rs `spinner` (library loading, consent, integrity panel, playlists); pages/music_bar.rs `bar-buffering` 1000 ms | match |
| `fadeIn` | 0.2 s ease-out | MusicPage:315 (toast), widget/Widget:12 (0.3 s) | pages/music.rs `toast_layer` (added in 11B); widget.rs (part A) | fixed in 11B (toast) |
| `fade-in-up` | 0.28 s / 0.15 s | global.scss:45, used by TomatoClock `.timerPage` 0.28 s and TodosPage `.copyPill` 0.15 s | app.rs `Page::Timer` (`timer-page-enter`); pages/todos.rs `todos-copy-pill` (both added in 11B) | fixed in 11B |
| `menuFadeIn` | 0.12 s ease-out | TrackContextMenu:50 (menu :47, submenu :144) | pages/music_menu.rs `tm-menu`, `tm-submenu` (added in 11B; opacity + 4 px rise, the 0.95 scale is not drawn) | fixed in 11B |
| `modalEntrance` | 0.2 s cubic-bezier | MarkdownEditor:649 (:545), RichTextInput:508 (:291) | ui/src/md_editor.rs, ui/src/rich_input.rs modal dialogs (added in 11B); modal.rs and todo_widgets `modal_overlay` for the other dialogs | fixed in 11B |
| `placeholderBreath` | 4 s ease-in-out infinite | RichTextInput:498 (use :171) | ui/src/rich_input.rs placeholder opacity .55-.85 | match |
| `todoRowFlash` | 2 s ease-out | TodosPage:290 (use :287) | pages/todos.rs `flash` (alpha .28 hold 30 %, then fade) | match |
| `dropHintEntrance` | 0.16 s ease-out | MarkdownEditor:499 (use :496) | ui/src/md_editor.rs `hint_el` (added in 11B) | fixed in 11B |

Real-window checks of the new wiring: the Timer page, Todos page and dialogs render with the new animations in release captures (`phase11b/n/*.png`). The hover tooltips and the copy pill need a pointer or a clipboard action and are not covered by a screenshot.

## Mismatches found and fixed in 11B

| Mismatch | Fix |
|---|---|
| Dialog overlays at 16 px (Todos dialogs, shortcuts sheet, notes modal) let page shapes show | Overlay is 28 px / 1.25 / 10 % tint everywhere (`todo_widgets::modal_overlay`, `todos_menus.rs`, `md_editor.rs`). |
| `fade-in-up` (Timer page entrance, copy pill), `menuFadeIn` (track menu, submenu), `fadeIn` (music toast), `dropHintEntrance`, `modalEntrance` on the two editor modals had no native animation | Added with the shared `animate` helper (ids per element, same durations and easings). |
| Text cut off with no "..." in flex-resolved widths (Todos titles, Activity file names, select labels, link popover rows) | Fixed in the vendored gpui `elements/text.rs`: the measure cache now also keys on the truncation width. Todos at 720 px wide shows "token re..." as Electron does. |
| Hover tooltips missing (`title=` attributes) | `chrome::titled` builds a glass tip after 0.5 s. Wired on the Todos rows (notes summary, priority, source, sub-issue crumb and count) and the `?` button. `plain_summary` ports `toPlainSummary` with its tests. |
| Queue and playlist rows did not move while dragging (a blue drop line instead) | Rows now shift as in dnd-kit's vertical sort (`music_queue::sort_shift`); the drop line is gone. |
| State dot ring drawn 1.5 px; Chromium draws 1 px at 100 % DPI | `ui::css_border` cuts a border of 1 px or more to whole device pixels. Used by the two state dots. |
| The "Effects gallery" button showed at the foot of the nav rail; Electron has none | Shown only in debug builds or with `LIZMETER_GALLERY` set. |

## Open items

| Item | Decision |
|---|---|
| `title=` tooltips outside the Todos list (detail page "Go to parent", attachments, state manager flags, music bar) | Not wired. Same helper applies; each needs only `titled(el, text)`. Not an effect, left to a later pass. |
| Scale in `menuFadeIn` / `modalEntrance` (0.95 to 1) | gpui cannot scale a laid-out element. The opacity and rise are drawn; the strip frames match closely. |
| `Sidebar.module.scss` | Dead in Electron, nothing to port. |
