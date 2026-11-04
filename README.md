# Markdown Viewer

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
test/               テスト
```

`dist/` はビルドで作るのでリポジトリには入れていない。

## 作り直す・確かめる

Node.js 18 以上が要る。ビルドとテストはネットを使わない。

```sh
node scripts/build.mjs              # dist/markdown-viewer.html を作る
node --test test/core.test.cjs      # core.js の単体テスト
node test/smoke.mjs                 # ビルド版をネット遮断のヘッドレス Edge で開いて確かめる
node test/check-zip.mjs docs.zip    # 手元の zip を開き、リンク切れ・画像切れ・図の失敗を数える
```

`smoke.mjs` は、CP932 のファイル名・CRLF・XSS を仕込んだ zip を作って読み込ませ、21 項目を確かめる。
ドラッグ＆ドロップとフォルダ選択は自動では確かめていない（人が操作して確かめる）。

## ライブラリの版を上げる

1. `scripts/fetch-vendor.mjs` の `LIBS` の版と URL を書き換える
2. `node scripts/fetch-vendor.mjs` で取得する（`vendor/VERSIONS.json` が書き直される）
3. `node test/smoke.mjs` で確かめる

ビルドは `vendor/` のハッシュが `VERSIONS.json` と一致しないと止まる。

| ライブラリ | 版 | 用途 | ライセンス |
| --- | --- | --- | --- |
| JSZip | 3.10.1 | zip の読み込み | MIT または GPLv3 |
| marked | 18.0.11 | Markdown の描画 | MIT |
| DOMPurify | 3.4.17 | 描画結果の無害化 | Apache-2.0 または MPL-2.0 |
| mermaid | 11.17.2 | 図の描画 | MIT |

ライセンス全文はビルド版にも埋め込んであり、画面左下の「このビューアについて」で読める。

## ライセンス

MIT（[LICENSE](LICENSE)）。同梱ライブラリはそれぞれのライセンスに従う（上の表）。

元は gist（https://gist.github.com/pooza/0f76c04cdc6c92f5569d3d4c071b9b7b）で配っていた 1 枚の HTML。
