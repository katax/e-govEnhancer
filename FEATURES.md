# e-Gov法令検索 Enhancer 機能一覧

この文書は利用者向けガイドではなく、機能棚卸しと仕様把握のためのメモです。
画面文言、ショートカット、保存キー、主要な処理場所を把握しやすい粒度でまとめています。

確認時点: 2026-05-25

## 1. 拡張の全体構成

- 対象サイト: `https://laws.e-gov.go.jp/*`
- Manifest: Manifest V3
- 権限:
  - `storage`
  - `tabs`
  - host permission: `https://laws.e-gov.go.jp/*`
- 主な画面:
  - `popup.html` / `popup.js`: 拡張ポップアップ検索、履歴、お気に入り
  - `content.js` / `content.css`: e-Gov法令ページ上の拡張機能
  - `viewer.html` / `viewer.js` / `viewer.css`: Liteモード法令ビューア
  - `options.html` / `options.js`: オプション画面
  - `background.js`: コマンド、タブ操作、メッセージ中継
- 共通処理:
  - `shared/egov-shared.js`: URL生成、法令検索API、法令情報抽出、HTMLエスケープ等

## 2. Chrome拡張ショートカット

`manifest.json` の `commands` で定義。
ユーザーは Chrome の拡張ショートカット設定から変更可能。

| コマンド | 既定キー | 動作 |
| --- | --- | --- |
| `_execute_action` | `Ctrl+Shift+E` | ポップアップを開く |
| `open_favorites_popup` | `Ctrl+Shift+F` | ポップアップをお気に入りモードで開く |
| `open_history_popup` | `Ctrl+Shift+H` | ポップアップを開いた法令履歴モードで開く |

実装:

- `background.js`
  - `chrome.commands.onCommand`
  - `openActionPopup(mode)`
  - `chrome.storage.session.requestedPopupMode`
- `popup.js`
  - 起動時に `requestedPopupMode` を参照して初期モードを切り替える
- `options.js`
  - `chrome.commands.getAll()` で現在の割り当てを表示

## 3. ポップアップ検索

実装: `popup.js`

### 3.1 法令検索

- 検索入力に対して法令名検索を行う。
- IME変換中は検索を抑制し、変換確定後に検索。
- 通常入力は短い debounce 後に検索。
- 検索APIは `shared/egov-shared.js` の `searchLawsByTitle()` を使用。
- 検索結果は新しいタブで開く。

主な状態:

- `currentResults`
- `focusedResultIndex`
- `queryHistory`

保存キー:

- `queryHistory`

### 3.2 検索結果操作

- 上下キーで結果フォーカス移動。
- `Enter` で選択した法令を開く。
- `Shift+Enter` または星ボタンでお気に入り追加/削除。
- `Ctrl+Enter` は Liteモード既定設定と逆のモードで開く。
- 検索結果クリックでも法令を開く。

### 3.3 Liteモード既定設定との連携

保存キー:

- `liteModeDefault`

仕様:

- `liteModeDefault = false`: 通常モードで開く。
- `liteModeDefault = true`: Liteモードで開く。
- `Ctrl+Enter` または Ctrl を押しながら開く操作では、設定と逆のモードで開く。
- Ctrl押下中はポップアップタイトルにLiteモード表示の状態が反映される。

## 4. ポップアップ履歴・お気に入り

実装: `popup.js`

### 4.1 開いた法令履歴

- 法令を開いたときに `openedLawHistory` へ保存。
- 最大件数は `HIST_MAX = 30`。
- 履歴モードで一覧表示。
- `Shift+Enter` で履歴項目をお気に入り追加/削除。
- `Delete` / `Ctrl+Delete` 系で項目削除。

保存キー:

- `openedLawHistory`

### 4.2 検索履歴

- 検索クエリを保存。
- 最大件数は `HIST_MAX = 30`。
- 入力が空のときなどに履歴を表示。

保存キー:

- `queryHistory`

### 4.3 お気に入り

- 最大件数は `FAV_MAX = 50`。
- 検索結果、履歴、法令ページ、Liteモードから追加/削除可能。
- フォルダ分類に対応。
- ドラッグ&ドロップで並び替え、フォルダ移動。
- フォルダ作成、リネーム、削除に対応。

保存キー:

- `favorites`
- `favFolders`
- `folderCollapsed`

## 5. 通常モード法令ページ拡張

実装: `content.js`

対象:

- `#provisionview` が存在する e-Gov 法令本文ページ

### 5.1 ヘッダー追加UI

法令ページ見出し付近に操作ボタンを追加。

- お気に入りボタン
- `ワイド`、`かっこ`、`逆リンク`、`定義` の状態表示付きトグルボタン
- Liteボタン

トグルボタンはお気に入りボタンとLiteボタンの間に配置し、Liteボタンと同じ体裁で表示する。`ワイド` は `w`、`かっこ` は `Shift+G`、`逆リンク` は `e` と同じ処理を実行し、`定義` は定義語ガイド設定を切り替える。

主な処理:

- `ensureHeaderControlHost()`
- `ensureFavoriteHeaderBadge()`
- `ensureHeaderToggleButtons()`
- `ensureLightweightViewerButton()`

### 5.2 Liteモードへの切り替え

- ヘッダーの `Lite` ボタンで Liteビューアへ遷移。
- `Alt+L` でも Liteビューアへ遷移。
- 入力欄フォーカス中でも `Alt+L` は動作する。

主な処理:

- `getLightweightViewerUrl()`
- `openLightweightViewerDirectly()`
- `openLightweightViewerFromPage()`

### 5.3 キーボードショートカット有効/無効

- `Alt+P` で通常ページ上のショートカット有効/無効を切り替える。
- 無効中も一部の管理系ショートカットは動作する。
- 右下のショートカットガイドボタンも状態表示を持つ。

主な状態:

- `extensionEnabled`

### 5.4 オプション画面を開く

- 通常ページ上で `Alt+O`。
- `background.js` へ `egov-open-options-page` メッセージを送信。

### 5.5 条文ジャンプ

- 数字キー `0-9` で条文ジャンプダイアログを開く。
- `.` 区切りで条・項・号を指定できる。
- ジャンプ履歴を持つ。
- `h` / `l` でジャンプ履歴の前後へ移動。
- ジャンプ時はページ上部ではなく概ね25%位置に対象を配置。

主な状態:

- `articleHistory`
- `articleJumpHistory`
- `articleJumpCursor`

### 5.6 条文ナビゲーション

- `n` / `p`: 次/前の条を画面上部寄りに表示。
- `d` / `u`: 約80%分スクロール。
- スクロール挙動はオプションの `scrollBehavior` に従う。

保存キー:

- `scrollBehavior`

### 5.7 ページ内検索

- `s` でページ内検索ダイアログ。
- 検索ヒットをハイライト。
- `Enter`: 次へ。
- `Shift+Enter`: 前へ。
- `Ctrl+Enter`: 現在位置から検索。
- 検索履歴を持つ。

主な状態:

- `searchState`
- `searchHistory`

### 5.8 法令検索ポップアップ

- `Alt+R` で現在の法令名を使った法令検索ダイアログを開く。
- 結果から別法令を開く。
- 結果のお気に入り追加/削除に対応。

### 5.9 目次ダイアログ

- `t`: 目次ダイアログを開く。
- `Shift+T`: 現在位置に近い目次項目へ初期フォーカス。
- 目次内で上下移動、ページ移動、Enter選択に対応。

主な処理:

- `showLawTocDialog()`
- `getLawTocElement()`
- `getNaturalTocFocusIndex()`

### 5.10 条文リンクコピー

- `a` で条文リンクコピーダイアログを開く。
- 現在位置付近の条・項・号を候補にする。
- コピー形式:
  - `Enter`: URL
  - `Shift+Enter`: 法令名 + 条項 + URL
  - `Ctrl+Enter`: 本文付き
- 候補移動:
  - `ArrowUp` / `ArrowDown`
  - `u` / `p` / `n` / `d`

主な処理:

- `showArticleLinkCopyDialog()`
- `collectProvisionLinkTargets()`
- `buildProvisionCopyPayload()`

### 5.11 お気に入り操作

- `f` で現在法令をお気に入り追加/削除。
- ヘッダーのお気に入りボタンでも操作可能。
- お気に入り状態は storage の変更にも追随。

保存キー:

- `favorites`

### 5.12 カラーピン

- スロット: `i`, `o`, `j`, `k`, `m`
- 各スロットに現在表示中の条文位置を保存。
- スロットが空ならピンを置く。
- スロットに現在法令のピンがあればその位置へジャンプ。
- スロットに別法令のピンがあれば、対象法令タブを探してジャンプ、なければ開く。
- `Shift + スロットキー` で強制解除。
- `b` でピン状態トーストの表示切り替え。

保存キー:

- `chrome.storage.session.colorPins`

関連:

- `background.js`
  - `egov-jump-color-pin`
  - `sendJumpWhenReady()`

### 5.13 ピン状態トースト

- ピンスロットの状態を表示。
- オプションでページ上に常時表示するかを設定可能。
- クリックでスロット操作。

保存キー:

- `pinToastDefaultVisible`

### 5.14 括弧内表示抑制

- `g`: 全角括弧内を薄く表示するモード（flat: #d8d8d8）を切り替え。
- `Shift+G`: 括弧内をさらに薄く表示するモード（nested: #ececec）を切り替え。
  - 内部名は nested だが対象範囲は g と同じで、違いは文字色の濃さのみ。
- 括弧グループにホバーすると対応範囲をハイライト。

主な状態:

- `parenthesesMuteMode`
- `mutedParenGroupElements`

### 5.15 数字表記切り替え

- `c`: 条文番号などの漢数字/アラビア数字表示を切り替える。
- 本文テキストの一部を直接変換する。

主な状態:

- `numberMode`

### 5.16 カタカナからひらがな変換

- `Alt+H`: 本文中のカタカナをひらがなへ変換。
- 一方向変換。
- 再実行しても二重変換しない。

主な状態:

- `kanaConverted`

### 5.17 サイドバー非表示

- `w`: 通常モード法令ページの左サイドバーを非表示/復元。
- オプションで初期状態を非表示にできる。

保存キー:

- `hideLawSidebarDefault`

### 5.18 ショートカットガイド

- `?`: ページ右下のショートカットガイドを表示。
- ガイドボタンをクリックしてショートカット有効/無効も切り替え可能。
- ガイド右上の `マニュアル` ボタンからユーザーマニュアルを開く。マニュアル用キーボードショートカットは設けない。

### 5.19 同一法令内の参照元リンク

- `逆リンク` が有効なとき、外部法令の参照元リンクを適用した後のアイドル時間に本文中の同一法令リンクを解析する。
- 同一法令内の参照元は外部参照データと統合し、同じ参照元ポップアップの先頭に薄緑色の `同一法令` として表示する。
- 同一法令内の参照元名は条・項・号と、その表示番号と同じ粒度の本文とし、法令名や条文見出しは表示しない。項が1つしかない条では第1項を省略する。本文は改行せず、行幅を超える部分を末尾の `…` で省略する。参照元一覧にはURLを表示しない。
- 参照元ポップアップのタイトルバーには、対象条項に続けて同一法令リンクと他法令リンクの現在の動作を表示する。Ctrlを押している間は両方の動作表示を反転し、一時切り替えの案内を隠す。Ctrlを離すと元の表示へ戻す。
- 同一の条・項・号から同じ対象への重複リンクは1件にまとめる。
- 「第○条から第○条まで」などの連続範囲は、明示された終点までの各条・項・号の参照元として展開する。
- 「前二条」「前三項」「前二号」などの相対範囲は、本文中の条・項・号の実際の並び順に従って指定数分の参照元として展開する。
- 通常モードとLiteモードの両方に適用する。LiteモードではXML本文中の明示的な「第○条」参照を同一法令リンクに変換してから解析する。解析結果は保存せず、表示中の本文から都度生成する。

## 6. 法令リンクのポップアップ抑止

実装: `content.js`

対象:

- 法令本文 `#provisionview` 内の `a[href]`
- 同一 origin かつ `/law/` 配下のリンク

仕様:

- オプション `lawRefClickEnabled = true` のとき:
  - 本文中の法令リンククリック時に e-Gov 標準ポップアップを抑止。
  - 同一法令内リンクはスクロール移動。
  - 別法令リンクは設定によりポップアップ表示または別タブ遷移。
- `Ctrl+クリック` で一時的に設定と逆の動作をする。
  - 抑止On時のCtrlクリック: 抑止Off相当。
  - 抑止Off時のCtrlクリック: 抑止On相当。
- オプション `lawRefOtherLawPopup = true` のとき:
  - 別法令リンクはポップアップ表示対象として扱う。
  - 同一法令リンクはスクロール移動。
- オプション `lawRefHoverPopup = true` のとき:
  - リンクホバーから一定時間で e-Gov 標準ポップアップを発火させる。

実装上の特徴:

- 透明シールド `#egov-ext-lawref-shield` をリンク上に配置してクリックを捕捉する。
- 抑止フローでは `openLawReferenceTarget()` を通す。
- 同一ページ内リンクは `jumpToHashTarget()` でスクロール。
- 別法令リンクは `background.js` の `egov-open-law-reference-tab` でタブを開く。
- 設定OffでもCtrl反転を拾うため、リンク監視自体は常時登録される。

保存キー:

- `lawRefClickEnabled`
- `lawRefHoverPopup`
- `lawRefOtherLawPopup`

## 7. Liteモード

実装: `viewer.html`, `viewer.js`, `viewer.css`

### 7.1 起動

- URL: `viewer.html?lawId=...&lawName=...&sourceUrl=...`
- 通常ページのLiteボタン、通常ページ `Alt+L`、ポップアップのLite既定設定から開く。
- e-Gov API v2 から法令本文・改正履歴を取得して表示。

### 7.2 通常モードへ戻る

- `通常モード` ボタン。
- `Alt+L` でも同じ処理を実行。
- `sourceUrl` があればそこへ戻り、なければ `https://laws.e-gov.go.jp/law/{lawId}` へ戻る。

### 7.3 表示設定

- フォントサイズ選択。
- 本文幅選択。
- 上部メニューの `かっこ`、`逆リンク`、`定義` ボタンで、Shift+G相当の括弧内表示抑制、外部法令からの逆参照リンク、定義語ガイドを切り替える。
- 各トグルボタンは有効時にアクティブ表示となり、選択欄・ショートカット・設定画面からの変更にも追従する。
- フォントサイズ、本文幅、定義語ガイドの設定は local storage に保存。

保存キー:

- `liteFontSize`
- `liteContentWidth`
- `liteDefTooltipEnabled`

### 7.4 改正時点選択

- 改正履歴を取得し、選択した revision で再表示。
- URLパラメータ `revisionId` を更新して遷移する。
- revision 未指定時は本日現在で施行中の改正IDを解決し、未施行の最新版を自動表示しない。
- 保存済み法令XMLがあれば先に表示し、バックグラウンドでe-Gov APIの現行版を確認・更新する。
- Cache Storageには取得した生の法令XMLを最大100件保存する。逆リンクや定義語リンクなどの加工は表示時に適用し、加工済みXMLは保存しない。

### 7.5 並べて表示

- `Alt+S` で比較/並列表示モードを切り替える。
- 右ペインを持つ。
- `Tab` で左右ペインのフォーカス切り替え。
- embedded mode では親フレームへ `postMessage` する。

主な状態:

- `compareMode`
- `focusedPane`
- `compareResults`

### 7.6 Lite内ショートカット

| キー | 動作 |
| --- | --- |
| `Alt+L` | 通常モードへ戻る |
| `Alt+O` | オプション画面を開く |
| `Alt+S` | 並べて表示切り替え |
| `s` | ページ内検索 |
| `0-9` | 条文ジャンプダイアログ |
| `h` / `l` | 条文ジャンプ履歴の前後 |
| `r` | ジャンプ前の位置に戻る |
| `n` / `p` | 次/前の条へ移動 |
| `d` / `u` | 約80%スクロール |
| `g` / `Shift+G` | 括弧内表示抑制 |
| `a` | 条文リンクコピー |
| `t` | 目次 |
| `?` | Liteショートカット一覧 |
| `Esc` | ダイアログを閉じる |

ショートカット一覧右上の `マニュアル` ボタンからユーザーマニュアルを開く。マニュアル用キーボードショートカットは設けない。

### 7.7 Lite内ページ内検索

- 通常ページと同様に本文内検索。
- `Enter`: 次へ。
- `Shift+Enter`: 前へ。
- `Ctrl+Enter`: 現在位置から検索。
- 検索履歴を持つ。

### 7.8 Lite内条文ジャンプ・目次

- 条番号指定ダイアログ。
- 目次ダイアログ。
- ジャンプ履歴インジケータ。

### 7.9 Lite内条文リンクコピー

- `a` でコピー対象選択ダイアログ。
- コピー形式:
  - `Enter`: URL
  - `Shift+Enter`: 法令名 + 条項 + URL
  - `Ctrl+Enter`: 本文付き

### 7.10 Lite内お気に入り

- ヘッダーのお気に入りボタンで追加/削除。
- 通常ポップアップと同じ `favorites` を使用。

## 8. オプション画面

実装: `options.html`, `options.js`

### 8.1 動作設定

| 設定 | 保存キー | 既定値 | 概要 |
| --- | --- | --- | --- |
| スムーズスクロール | `scrollBehavior` | `instant` | 条文ジャンプ、検索ナビ等のスクロールをアニメーション表示 |
| Liteモードをデフォルトにする | `liteModeDefault` | `false` | ポップアップから法令を開くとき Lite を優先 |
| 通常モードでサイドバーを非表示にする | `hideLawSidebarDefault` | `false` | 法令ページ初期表示でサイドバーを隠す |
| 法令リンクのポップアップ抑止 | `lawRefClickEnabled` | `true` | 本文中リンクのe-Govポップアップを抑止してスクロール移動 |
| 他の法令のみポップアップ表示 | `lawRefOtherLawPopup` | `true` | 別法令リンクはポップアップ表示対象にする |
| マウスオーバーでポップアップ | `lawRefHoverPopup` | `false` | リンクホバーでe-Govポップアップを発火 |
| ピン状態の常時表示 | `pinToastDefaultVisible` | `true` | カラーピン状態トーストを常時表示 |

### 8.2 ショートカットキー設定表示

- `chrome.commands.getAll()` で現在の拡張ショートカットを表示。
- Chrome の `chrome://extensions/shortcuts` へのリンクを持つ。

### 8.3 お気に入りの保存と読み込み

- お気に入り、フォルダ、フォルダ折りたたみ状態をJSONでエクスポート。
- JSONインポート時に構造検証を行う。
- 最大お気に入り数は50件。
- インポート後、必要に応じて開いている法令タブの再読み込みを促す。

エクスポート形式:

- `type`: `egov-extension-favorites`
- `version`: `1`
- `exportedAt`
- `favorites`
- `favFolders`
- `folderCollapsed`

## 9. Background処理

実装: `background.js`

### 9.1 ポップアップ起動モード指定

- Chromeコマンドからポップアップを開く前に `chrome.storage.session.requestedPopupMode` を設定。
- `chrome.action.openPopup()` が使えない場合はリクエストをクリア。

### 9.2 Liteビューアを開く

メッセージ:

- `egov-open-lightweight-viewer`

動作:

- 送信元タブがあれば同じタブを `viewer.html` へ更新。
- なければ新規タブを作成。

### 9.3 法令参照リンクを別タブで開く

メッセージ:

- `egov-open-law-reference-tab`

動作:

- 指定URLをアクティブな新規タブで開く。

### 9.4 外部参照キャッシュ

- 外部参照データは `background.js` が `data/references.json` から法令単位で切り出し、IndexedDB の `egov-extension-references` / `bundled_cache` ストアにオンデマンド保存する。
- 手動インポートしたデータは `laws` / `meta` ストアに保存し、同梱データ由来のキャッシュとは分離する。
- 拡張更新時に自動クリアするのは同梱データ由来の `bundled_cache` のみで、手動インポートデータは保持する。

### 9.5 カラーピン別法令ジャンプ

メッセージ:

- `egov-jump-color-pin`

動作:

- 対象法令が既に開いていればそのタブへ移動。
- なければ対象法令を新規タブで開く。
- 対象ページ読み込み後、`egov-perform-color-pin-jump` を content script に送って位置へジャンプ。

## 10. 保存データ一覧

### chrome.storage.local

| キー | 用途 |
| --- | --- |
| `scrollBehavior` | スクロール挙動。`instant` / `smooth` |
| `liteModeDefault` | ポップアップから開く既定モード |
| `hideLawSidebarDefault` | 通常ページのサイドバー初期非表示 |
| `pinToastDefaultVisible` | ピン状態トーストの常時表示 |
| `lawRefClickEnabled` | 法令リンクポップアップ抑止 |
| `lawRefHoverPopup` | 法令リンクホバーポップアップ |
| `lawRefOtherLawPopup` | 別法令のみポップアップ表示 |
| `queryHistory` | ポップアップ検索履歴 |
| `openedLawHistory` | 開いた法令履歴 |
| `favorites` | お気に入り法令 |
| `favFolders` | お気に入りフォルダ |
| `folderCollapsed` | お気に入りフォルダ折りたたみ状態 |
| `liteFontSize` | Liteモード本文フォントサイズ |
| `liteContentWidth` | Liteモード本文幅 |

### chrome.storage.session

| キー | 用途 |
| --- | --- |
| `requestedPopupMode` | Chromeコマンドからポップアップを開く際の初期モード |
| `colorPins` | カラーピンのスロット状態 |

## 11. 主な制限・注意点

- `content.js` の一部コメント・画面文言は文字化けしているが、検索結果上は日本語文字列として残っている箇所もある。
- `options.html` には `lawRefClickToggle` と重複した未使用トグル `unusedDuplicateLawRefClickToggle` が存在する。
- 法令リンクポップアップ抑止は e-Gov 側のイベント挙動に依存するため、透明シールドと capture イベントで抑止している。
- Liteモードは e-Gov API v2 のレスポンス構造に依存する。
- カラーピンは session storage のため、ブラウザセッションをまたぐ永続機能ではない。
- 通常ページのショートカットは入力欄フォーカス中には原則抑制されるが、`Alt+P`, `Alt+O`, `Alt+L` など一部は例外的に動作する。

## 定義用語ガイド

- 通常モード（`content.js`）と Lite モード（`viewer.js`）で、法令内で定義されている用語を本文中にマークする。
- マークされた定義用語は、設定に応じてクリックまたはマウスホバーでツールチップを表示する。
- ツールチップには定義内容と定義箇所への移動リンクを表示する。
- 定義箇所への移動、条文ジャンプ、定義用語リンクによる移動では、ページ左下に「Rでジャンプ前の位置に戻る（第○条近辺）」ボタンを表示する。通常モードと Lite モードのどちらでも `r` キーで戻れる。
- 戻るボタンは再ジャンプ時に差し替え、10分後に自動で消える。
- 定義語抽出は `shared/egov-shared.js` の定義用語向け共通テキスト処理を利用し、DOM探索とマーキングは通常モード/Liteモードそれぞれの本文構造に合わせて行う。

保存キー（`chrome.storage.local`）:

- `liteDefTooltipEnabled`: 定義用語ガイドの有効/無効。歴史的なキー名のため `lite` を含むが、通常モードと Lite モードの両方を制御する。
- `defTooltipClickOnly`: `true` の場合、定義用語ガイドをクリック時のみ表示する。既定値は `true`。
