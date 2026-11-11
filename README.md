# Markdown Viewer

[![test](https://github.com/pooza/markdown-viewer/actions/workflows/test.yml/badge.svg)](https://github.com/pooza/markdown-viewer/actions/workflows/test.yml)

Markdown の文書一式（zip かフォルダ）を、ブラウザだけで読むための 1 枚の HTML。
**ネットにつながらない環境で使える**よう、ライブラリはすべて HTML に埋め込んである。

## 使い方

`dist/markdown-viewer.html` をブラウザ（Edge / Chrome）で開き、次のどれかで文書を渡す。

- 「zip を開く」で zip を選ぶ
- 「フォルダを開く」でフォルダを選ぶ
- zip・フォルダ・ファイルを画面にドラッグ＆ドロップする

最初に README.md（無ければ index.md、それも無ければ最初の .md）を開く。

## できること

- Markdown（GitHub 風の表・チェックボックスなど）と Mermaid の図を描く
- 表は、どのセルも短い列を折り返さない（列の多い表で項目名などが縦書きにならない）。文章は読みやすい幅のまま、表だけは窓の幅まで広がり、それでも収まらない表は表の中で横にスクロールする
- 本文の幅に縮んで表示される横に広い図は、「拡大」で原寸の全画面表示にできる（拡大・縮小・画面に収める、Esc で閉じる）
- 文書の間のリンク、`文書.md#節` や `#節` で節へ飛ぶ。見出しの ID は GitHub と同じ規則
- ブラウザの「戻る／進む」で文書の間を行き来する
- 相対パスの画像を zip・フォルダの中から読む
- フォルダへのリンクは中身の一覧を、テキストファイル（.txt・.sql・.csv など）は中身を表示する。表示できないファイル（.xlsx など）は保存させる
- Shift_JIS（CP932）の文書・テキストと、Windows で作った zip の日本語ファイル名を読む
- リンク切れ・画像切れを赤で示す
- 文書の中の HTML は無害化する（`<script>`・イベント属性・`javascript:` は消える）
- 外部へのリンクは別のタブで開く。外部の画像はネットが無ければ表示されない

## 構成

```text
src/viewer.html     画面（HTML と CSS）。直接開けば開発版として動く（vendor/ を読む）
src/app.js          画面の処理
src/core.js         画面に依存しない処理（パス・文字コード・見出し ID）
vendor/             同梱ライブラリ。版とハッシュは VERSIONS.json、ライセンスは licenses/
scripts/build.mjs   src と vendor を 1 枚にまとめて dist/markdown-viewer.html を作る
scripts/fetch-vendor.mjs  ライブラリの取得（版を上げるときだけ。ネットが要る）
scripts/codex-wait.mjs    PR に付く Codex のレビューを待つ（作業用。CLAUDE.md を参照）
test/               テスト
package.json        版と npm run のコマンド
biome.json          整形と Lint の設定
CLAUDE.md           作業の決まりと落とし穴（Claude Code 向け）
```

`dist/` はビルドで作るのでリポジトリには入れていない。

## 作り直す・確かめる

Node.js 22 以上が要る。ビルドとテストはネットを使わない（`npm install` だけは Biome の取得にネットが要る）。

```sh
npm install                     # 開発用の道具（Biome）を入れる。ビルドとテストだけなら不要
npm run build                   # dist/markdown-viewer.html を作る
npm test                        # core.js の単体テスト
npm run smoke                   # ビルド版をネット遮断のヘッドレス Edge で開いて確かめる
npm run check-zip -- docs.zip   # 手元の zip を開き、リンク切れ・画像切れ・図の失敗を数える
npm run lint                    # Biome で整形と Lint を確かめる（lint:fix で直す）
```

`smoke` は、CP932 のファイル名・CRLF・XSS を仕込んだ zip を作って読み込ませ、26 項目を確かめる。
ドラッグ＆ドロップとフォルダ選択は自動では確かめていない（Edge の実機で、zip・フォルダ・複数ファイルのドロップを確かめた）。

main・develop への push と Pull Request では、GitHub Actions（`.github/workflows/test.yml`）が同じことを行う。
lint・単体テスト・ビルドは Ubuntu、`smoke` は Edge の入っている Windows の Runner で動く。
そこでビルドした版は実行結果の Artifacts から取れる。

整形と Lint は [Biome](https://biomejs.dev/)。設定は `biome.json`（2 スペース、1 行 100 桁、シングルクォート、末尾カンマあり）。
`src/` はモジュールではない普通の script なので `'use strict'` を残す（`noRedundantUseStrict` を切っている）。

## ブランチとリリース

- 作業は `develop`。リリースのときに `main` へマージする
- 版は `package.json` の `version`。ビルド版の「このビューアについて」に版・ビルド日・コミットが出る
- 配布物はビルド版 1 枚だけ。**タグを push すると GitHub Actions（`.github/workflows/release.yml`）がテスト・ビルドし、
  `markdown-viewer.html` をそのタグのリリースにアセットとして添付する**（`dist/` はリポジトリに入れない）

手順（例: 1.1.0 を出す）:

```sh
# 1. develop で版を上げ、確かめる
npm version 1.1.0 --no-git-tag-version
npm run lint && npm test && npm run smoke
git commit -am "release: v1.1.0"

# 2. main へマージしてタグを打ち、push する（ここから先は Actions が行う）
git checkout main
git merge --ff-only develop
git tag -a v1.1.0 -m "v1.1.0"
git push origin main develop v1.1.0
git checkout develop
```

Actions は次を行う。⚠ タグと `package.json` の版が一致しないと止まる。

1. タグをチェックアウトし、単体テストと `smoke`（ヘッドレス Edge）を通す
2. ビルドする（「このビューアについて」にタグ名が出る）
3. そのタグのリリースが無ければ作り（リリースノートは自動生成）、あればアセットだけ差し替える

リリースノートは後から GitHub の画面で書き足してよい。
既存のリリースにアセットを付け直すときは、Actions の画面から `release` を手動実行してタグを指定する。
添付したファイルは `https://github.com/pooza/markdown-viewer/releases/latest/download/markdown-viewer.html` で常に最新版を取れる。

## ライブラリの版を上げる

1. `scripts/fetch-vendor.mjs` の `LIBS` の版と URL を書き換える
2. `npm run vendor` で取得する（`vendor/VERSIONS.json` が書き直される。ネットが要る）
3. `npm run smoke` で確かめる

ビルドは `vendor/` のハッシュが `VERSIONS.json` と一致しないと止まる（`npm run vendor:check` でも確かめられる）。
| ライブラリ | 版 | 用途 | ライセンス |
| --- | --- | --- | --- |
| JSZip | 3.10.1 | zip の読み込み | MIT または GPLv3 |
| marked | 18.0.11 | Markdown の描画 | MIT |
| DOMPurify | 3.4.17 | 描画結果の無害化 | Apache-2.0 または MPL-2.0 |
| mermaid | 11.17.2 | 図の描画 | MIT |

ライセンス全文はビルド版にも埋め込んであり、画面左下の「このビューアについて」で読める。

## ライセンス

MIT（[LICENSE](LICENSE)）。同梱ライブラリはそれぞれのライセンスに従う（上の表）。

元は gist（ https://gist.github.com/pooza/0f76c04cdc6c92f5569d3d4c071b9b7b ）で配っていた 1 枚の HTML。
