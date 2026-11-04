# markdown-viewer の作業の決まり

利用者向けの説明・コマンド・リリース手順は [README.md](README.md) にある。ここには作業する側の決まりと落とし穴だけを書く。

## 公開リポジトリとしての注意

- **個人の公開リポジトリ（MIT）。** どの案件・組織から使う道具でもあるので、特定の案件・組織に紐づくものを入れない
  - 会社名・部署名・案件名・社内の文書名、社内のサーバ名やパス・URL
  - 個人の環境のパス（`C:\Users\…`、Node の置き場所など）
  - テストの例やコメントの例も中立にする（実在の文書の見出しや業務の言葉を使いがち）
- 使い方の例を書くときは、どこの案件でも通じる一般的な例にする
- 作者メールは **`tkoishi@b-shock.co.jp`**（リポジトリ単位の `git config user.email` で設定する）。
  PC の既定（global）が別のアドレスのことがあるので、新しく clone したら最初に確かめる:
  `git config user.email`
- 公開済みなので、混入に気づいたら履歴の書き換えで済ませず、まず相談する

## 環境

- Node.js 22 以上（`node --test` のグロブに 21 以上が要る）。PATH に無い PC もあるので、無ければ置き場所をユーザーに聞く
- Python は使わない（無い PC で作業する前提）
- `npm run smoke` と `npm run check-zip` は **Windows の Edge が要る**（`test/edge.mjs` が既定の場所から探す）。
  Edge の無い環境では、push 後に GitHub Actions の smoke（windows-latest）で確かめる
- `npm install` は Biome の取得だけ。ビルドとテストはネットを使わない。`package-lock.json` は git に入れない

## 落とし穴

- **package.json に `"type": "module"` を付けない。** `src/core.js` を画面（普通の script）とテスト（`require`）の両方で使っているため。付けると単体テストが全滅する
- Windows の `msedge.exe` は起動後すぐ制御を返し、`--dump-dom` も標準出力に出ない。ヘッドレス Edge の操作は DevTools プロトコル（`test/edge.mjs`）で行う
- mermaid・DOMPurify の中に `</body>` という文字列がある。ビルドで何かを差し込むときは、必ず**最後の** `</body>` の前（`lastIndexOf`）
- `src/` はモジュールではないので `'use strict'` を残す（Biome の `noRedundantUseStrict` は切ってある）
- 見出し ID は GitHub と同じ規則（`user-content-` 接頭辞で付け、リンクは JS で解決する）。変えると既存の文書のアンカーが切れる
- `vendor/` を手で書き換えない。版を上げる手順は README の「ライブラリの版を上げる」。ハッシュが `vendor/VERSIONS.json` と合わないとビルドが止まる

## 自動では確かめていないこと

変更がここに触れるときは、人に実機で確かめてもらう。

- ドラッグ＆ドロップ・フォルダ選択（#3）
- 古い Edge（Chromium 初期の版）での動作
- Windows の Explorer の「圧縮」で作った zip（CP932 のファイル名は自作の zip でだけ確かめている）

## 課題・ブランチ・PR

- 課題は **GitHub Issue** で管理する
- 作業は `feat/<issue 番号>-<短い名前>` を `develop` から切り、`develop` へ Pull Request を出す
- push 前に `npm run lint && npm test && npm run build && npm run smoke` を通す（smoke は Edge のある環境だけ）
- コミットメッセージは `add:`・`fix:`・`update:`・`release:` などで始め、本文は日本語
- リリース（`develop` → `main` の ff マージとタグ）は README の手順どおり。タグと `package.json` の版が一致しないと Actions が止まる

## Codex のレビュー

PR には ChatGPT Codex のレビューが付く。扱い方は ginseng-style の codex-review スキルに従う。

- ginseng プラグインを入れていれば、その `codex-review` スキルを使う。入っていなければ正本を読む:
  `gh api repos/pooza/ginseng-style/contents/plugins/ginseng/skills/codex-review/SKILL.md -H "Accept: application/vnd.github.raw"`
- 要点: 4 経路（review・inline・issue コメント・リアクション）を走査する／👀 と要約コメントは成果物ではない／
  指摘には返信と 👍 / 👎 の両方を付ける／閉じる前にもう一度走査する
- ⚠ **P2 は出されたものを 1 回直して返信するだけ。`@codex review` で頼み直さない。** 頼み直して繰り返すのは P1 のときだけ。
  繰り返すと P2 の質が際限なく下がり、時間ばかりかかる（codex-review スキルの「再走査」よりこちらを優先する）
- 待機は `node scripts/codex-wait.mjs pooza/markdown-viewer <PR 番号> [基点JSON]`（jq の無い Windows でも動く）。
  基点は、レビューを起こす前（自分の返信より前）の件数を採る。最後の行が `DONE` / `TIMEOUT`、gh が失敗したら exit 2
