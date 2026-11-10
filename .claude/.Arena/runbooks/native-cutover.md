---
scope: native/Packager.toml, native/crates/services/src/soak.rs, native/crates/app/src/soak_cli.rs
updated: 2026-11-10
source: ares (2026-11-09-native-rust-directx-full-port, phase 12)
language: zh-TW
---

# 原生版 LizMeter 換裝手冊（soak、換裝、回復）

讀者：你自己（兩台 Windows 電腦的使用者）。目的：把 Electron 版換成原生版，資料不遺失，隨時能退回。

## 先看這裡：順序與規則

```
備份 ─▶ soak（複本上跑數天）─▶ 乾淨？ ─否─▶ 回報問題，不換裝
                                  │
                                 是
                                  ▼
                      第 1 台換裝 ─▶ 觀察 ─▶ 第 2 台換裝
                      （任何時候出問題 ─▶ 回復）
```

必守規則：

1. 一次只讓一個程式寫同一個資料夾。換裝前先關閉 Electron 版與原生版。
2. soak 絕不使用真正的 OneDrive 同步資料夾（`C:\Users\lizard_liang\OneDrive\Apps\sync`）。程式會拒絕。
3. 安裝程式不會刪除 `%APPDATA%\lizmeter`。你仍然要先備份。
4. 下面的指令以 PowerShell 執行。`$exe` 代表原生版執行檔，soak 階段用建置出來的檔案：

```powershell
$exe = "C:\Users\lizard_liang\personal\PersonalTool\LizMeter\native\target\release\lizmeter.exe"
```

## 1. 備份（soak 之前、每次換裝之前都做）

1. 關閉 LizMeter（Electron 版），確認工作管理員沒有 `LizMeter.exe`。
2. 複製使用者資料夾：

```powershell
$stamp = Get-Date -Format "yyyyMMdd-HHmm"
Copy-Item -Recurse "$env:APPDATA\lizmeter" "$env:USERPROFILE\lizmeter-backup-$stamp"
```

3. 複製同步資料夾（只讀取，不改動來源）：

```powershell
Copy-Item -Recurse "C:\Users\lizard_liang\OneDrive\Apps\sync" "$env:USERPROFILE\lizmeter-sync-backup-$stamp"
```

4. 確認備份裡有 `lizmeter.db`：

```powershell
Test-Path "$env:USERPROFILE\lizmeter-backup-$stamp\lizmeter.db"
```

5. 保存 Electron 安裝檔，回復時要用。已安裝的版本：

```powershell
(Get-ItemProperty "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\d7c9c3d8-3982-5ac5-a5ff-124a887808d8").DisplayVersion
```

   本機 `release\` 資料夾有 `LizMeter Setup 1.14.1.exe`。1.14.2 與更新版本沒有現成安裝檔：在 master 執行 `bun run dist` 產生，複製到 `$env:USERPROFILE\lizmeter-installers\`。master 另有尚未發行的修正 `faec32c`、`6c8ee6c`（ffmpeg checksum）；1.14.3 會包含它們。

## 2. 開始 soak（在複本上跑原生版）

soak 使用 `%APPDATA%\lizmeter-soak`（資料庫複本）與 `%APPDATA%\lizmeter-soak-sync`（測試用同步資料夾）。Electron 版可以繼續開著：soak 有自己的資料夾與自己的 named pipe（`\\.\pipe\lizmeter-soak`）。

1. 建置原生版（在 `native\`）：

```powershell
cd C:\Users\lizard_liang\personal\PersonalTool\LizMeter\native
cargo build --release
```

2. 為了得到一致的資料庫複本，先關閉 Electron 版，然後建立 soak 複本：

```powershell
& $exe --soak-setup | Out-String
```

   成功時最後幾行是 `Soak profile ready`、`Baseline: <N> todos, ids digest <16 位 16 進位>`。**記下 Baseline 那一行。**
   - 已有 soak 資料夾時，程式拒絕並不覆蓋。要重來，先刪除：`Remove-Item -Recurse "$env:APPDATA\lizmeter-soak", "$env:APPDATA\lizmeter-soak-sync"`
   - 測試同步資料夾改到別處：`--soak-setup --soak-sync D:\soak-sync`。路徑含 `OneDrive` 會被拒絕。

3. 啟動 soak：

```powershell
Start-Process $exe -ArgumentList "--soak"
```

   用它做日常操作（計時、todo、筆記、設定同步）。soak 不會寫入 `%APPDATA%\lizmeter`，也不會寫入真正的 OneDrive 資料夾。
4. soak 的 token 是獨立的：要測 GitHub、Jira、Linear，在 soak 的設定頁重新輸入。

## 3. 乾淨執行的標準與檢查方式

每天至少檢查一次，連續數天都乾淨才換裝。先關閉 soak 視窗，再執行：

```powershell
& $exe --soak-check | Out-String
```

輸出最後一行 `result: CLEAN` 表示乾淨，`result: NOT CLEAN` 表示不乾淨（結束碼 3）。

| 標準 | 怎麼查 | 通過的樣子 |
|---|---|---|
| 沒有合併錯誤 | 輸出的 `merge-failed notices (not dismissed)` | `0` |
| 沒有被跳過的 oplog 項目 | 輸出的 `oplog-entry-skipped notices (not dismissed)` | `0` |
| todo id 收斂 | 見下方三項 | 全部成立 |

todo id 收斂的三項檢查：

1. 第 0 天：`--soak-check` 的 `todo ids digest` 與 `--soak-setup` 印出的 Baseline digest 相同（尚未新增 todo 時）。
2. 關閉 soak、再執行一次 `--soak-check`，`todo ids digest` 不變。
3. 輸出沒有 `other notice todo-id-reassigned`。出現這一行表示 id 被重新指派，要回報。

其他輔助檢查：

- 同一份資訊也在 soak 的設定頁（同步區塊的通知清單）。
- 看測試同步資料夾裡的 oplog 檔：輸出的 `oplog files:` 這一行會列出。soak 應該只有一個檔（這台電腦自己的 device id）。
- 發現 `NOT CLEAN`：不要換裝。保留 `%APPDATA%\lizmeter-soak` 與 `%APPDATA%\lizmeter-soak-sync`，回報問題時附上 `--soak-check` 的完整輸出。

soak 只在一台電腦的本機資料夾上跑，所以它檢查不到兩台電腦之間的收斂。兩台電腦之間的檢查在第 4、5 節的換裝步驟裡做。

## 4. 第 1 台電腦換裝

先決條件：soak 連續數天都乾淨，第 1 節的備份是今天做的。

1. 關閉 Electron 版與 soak 視窗。
2. 確認 `%APPDATA%\lizmeter` 的備份存在（第 1 節）。
3. 建置安裝檔（在 `native\`，需要 `cargo install cargo-packager --locked`）：

```powershell
cd C:\Users\lizard_liang\personal\PersonalTool\LizMeter\native
cargo build --release
cargo packager --release -c Packager.toml
```

   安裝檔在 `native\target\packager\`。
4. 執行安裝檔。它會做三件事：
   - 靜默移除 Electron 版（用 Electron 自己的解除安裝程式）。
   - 安裝原生版到 `%LOCALAPPDATA%\LizMeter`，建立開始功能表的「LizMeter」。
   - 不碰 `%APPDATA%\lizmeter`。
   - Electron 版還在執行時，安裝程式會停止並說明；關閉後重新執行。
5. 從開始功能表啟動 LizMeter。確認：
   - todo、session 與備份前一樣多。
   - 設定頁的資料資料夾仍是原本的路徑，同步仍是開啟的。
6. 第 2 台電腦還是 Electron 版：兩邊透過 OneDrive 同步，這就是混合版本期間。在兩台電腦各新增一個 todo，確認兩邊都出現，id 沒有重複。
7. 檢查沒有合併錯誤（關閉原生版後）：

```powershell
& "$env:LOCALAPPDATA\LizMeter\lizmeter.exe" --soak-check --check-dir "$env:APPDATA\lizmeter" | Out-String
```

   `merge-failed` 與 `oplog-entry-skipped` 都要是 `0`。
8. 用一天以上。沒問題再做第 2 台。

## 5. 第 2 台電腦換裝

1. 重複第 1 節（備份）與第 4 節的第 1 到第 5 步。
2. 兩台都是原生版後，在兩台各新增一個 todo，確認互相同步。
3. 兩台各執行第 4 節第 7 步的指令。兩邊的 `todo ids digest` 在同步完成、兩台都關閉之後必須相同。不同：回報，並保留兩台的輸出。

## 6. 回復（退回 Electron 版）

任何一台電腦都可以單獨退回，資料資料夾不用還原（兩個版本用同一份資料）。

1. 關閉原生版。
2. 解除安裝原生版：設定 → 應用程式 → LizMeter（路徑 `%LOCALAPPDATA%\LizMeter`）。解除安裝不刪除 `%APPDATA%\lizmeter`。
3. 安裝 Electron 版（1.14.2；見第 1 節第 5 步的安裝檔位置）。
4. 啟動，確認資料都在。
5. 只有在資料真的壞掉時，才還原備份：先關閉所有 LizMeter，把 `%APPDATA%\lizmeter` 改名為 `lizmeter-broken`，再把 `$env:USERPROFILE\lizmeter-backup-<時間>` 複製回 `%APPDATA%\lizmeter`。不要直接覆蓋。
6. 兩台都退回之後，才可以刪除 soak 資料夾：`Remove-Item -Recurse "$env:APPDATA\lizmeter-soak", "$env:APPDATA\lizmeter-soak-sync"`

## 7. 你還欠的檢查（我沒有執行，需要你在真實環境做）

| 檢查 | 為什麼沒做 | 怎麼做 |
|---|---|---|
| 安裝程式在隔離環境實跑 | 這台沒有 Windows Sandbox，也不能對真實使用者設定執行安裝程式 | 在另一個 Windows 帳號或虛擬機執行安裝檔；確認 Electron 被移除、開始功能表有 LizMeter、`%APPDATA%\lizmeter` 沒變 |
| 即時 read-only tracker 煙霧測試 | 需要真實 Claude Code session 檔 | soak 啟動後，開一個 Claude Code session，看 Activity 頁出現它 |
| 真正的 yt-dlp 擷取 | 需要網路與真實影片 | soak 的 Music 頁加入一個 YouTube 連結，確認下載與播放 |
| 真正的 ffmpeg 下載 | 需要網路 | 全新的 soak 設定頁觸發 ffmpeg 下載；原生版已有 manifest 備援 |
| 即時指標與鍵盤檢查 | 不能用 SendKeys 或前景輸入自動化 | 用滑鼠與鍵盤操作：拖曳排序、中文輸入法（IME）、全域快捷鍵、widget 拖曳 |
| 真實 OneDrive 同步（兩台之間） | soak 刻意不碰真實資料夾 | 第 4 節第 6 步與第 5 節第 2 步 |
| 已安裝版本的確認 | 登錄檔顯示 DisplayVersion 為 1.14.0，與預期的 1.14.2 不同 | 第 1 節第 5 步的指令；以實際值為準 |

## 疑難排解

| 現象 | 原因 | 處理 |
|---|---|---|
| `Soak mode refuses ... inside a OneDrive folder` | 測試同步資料夾路徑含 OneDrive | 用本機路徑，例如 `--soak-sync D:\soak-sync` |
| `No soak profile at ...` | 還沒做 `--soak-setup` | 先做第 2 節第 2 步 |
| `... already holds files` | soak 資料夾已存在，setup 不覆蓋 | 第 2 節第 2 步的 `Remove-Item` 後重做 |
| 啟動時說資料夾被另一個 LizMeter 使用 | 另一個原生版或 Electron 版正在寫同一個資料夾 | 關閉它；soak 資料夾不受 Electron 版影響 |
