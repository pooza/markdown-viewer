// 画面。zip・フォルダ・ドロップから「ファイルの集まり」を作り、Markdown を描く。
(() => {
  'use strict';

  const C = window.MdvCore;
  const $ = (id) => document.getElementById(id);
  const contentEl = $('markdown-content');
  const scrollEl = $('content');

  // ---- 状態 ---------------------------------------------------------------

  // source: { id, name, files: Map<path, { read(): Promise<Uint8Array> }> }
  let source = null;
  let paths = []; // source.files のキー（ソート済み）
  let listedPaths = []; // サイドバーに出すもの（Markdown とテキスト）
  let currentPath = null; // いま開いているファイル（フォルダ一覧のときはフォルダのパス）
  let folderStates = {}; // フォルダの開閉
  let searchFilter = '';
  let objectUrls = []; // 表示中の画像など。文書を切り替えたら解放する
  let renderSeq = 0; // 描画の追い越し防止

  // ---- ライブラリの確認 ---------------------------------------------------

  const hasMermaid = typeof mermaid !== 'undefined';
  const missing = [];
  if (typeof JSZip === 'undefined') missing.push('JSZip（zip の読み込み）');
  if (typeof marked === 'undefined') missing.push('marked（Markdown の描画）');
  if (typeof DOMPurify === 'undefined') missing.push('DOMPurify（表示内容の無害化）');

  if (missing.length > 0) {
    showError(
      '必要なライブラリを読み込めませんでした。\n\n' +
        missing.map((m) => `・${m}`).join('\n') +
        '\n\nビルド版（dist/markdown-viewer.html）を使っているか確かめてください。' +
        'src/viewer.html を直接開く場合は vendor/ が必要です。',
    );
    for (const id of ['open-zip', 'open-folder', 'search-box']) $(id).disabled = true;
    return;
  }

  if (hasMermaid) {
    mermaid.initialize({ startOnLoad: false, theme: 'default', securityLevel: 'strict' });
  }

  // ---- 読み込み口 ---------------------------------------------------------

  $('open-zip').addEventListener('click', () => $('zip-input').click());
  $('open-folder').addEventListener('click', () => $('folder-input').click());

  $('zip-input').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = ''; // 同じファイルを選び直せるように
    if (file) await guarded(() => openZipFile(file));
  });

  $('folder-input').addEventListener('change', async (e) => {
    const files = Array.from(e.target.files);
    e.target.value = '';
    if (files.length === 0) return;
    const entries = files.map((f) => ({ path: f.webkitRelativePath || f.name, file: f }));
    const rootName = entries[0].path.split('/')[0];
    await guarded(() => openSource(rootName, fromFiles(entries)));
  });

  // ドラッグ＆ドロップ。zip 1 つならその中身、それ以外（フォルダ・複数ファイル）はまとめて開く。
  let dragDepth = 0;
  document.addEventListener('dragenter', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth += 1;
    document.body.classList.add('dragging');
  });
  document.addEventListener('dragover', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  });
  document.addEventListener('dragleave', (e) => {
    if (!hasFiles(e)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) document.body.classList.remove('dragging');
  });
  document.addEventListener('drop', async (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth = 0;
    document.body.classList.remove('dragging');
    // DataTransfer は await を挟むと読めなくなるので、ここで項目を取り出しておく
    const items = Array.from(e.dataTransfer.items || [])
      .filter((item) => item.kind === 'file')
      .map((item) => (item.webkitGetAsEntry ? item.webkitGetAsEntry() : null));
    const plainFiles = Array.from(e.dataTransfer.files || []);
    await guarded(() => openDropped(items, plainFiles));
  });

  function hasFiles(e) {
    return e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');
  }

  // メールの添付・Explorer で開いた zip の中・オンデマンドのクラウドのファイルなど、実体がまだ
  // ディスクに無いものは entry.file() が EncodingError（A URI supplied to the API was malformed…）で
  // 失敗する。DataTransfer の File は読めるので、zip 1 つはそれを使い、それ以外も失敗したらそれに替える。
  async function openDropped(entries, plainFiles) {
    const valid = entries.filter(Boolean);
    // 「〜.zip」という名前のフォルダは除く（entry があればファイルであることを確かめる）
    const isZipFile =
      plainFiles.length === 1 &&
      /\.zip$/i.test(plainFiles[0].name) &&
      (valid.length === 0 || (valid.length === 1 && valid[0].isFile));
    if (isZipFile) {
      return openZipFile(plainFiles[0]);
    }
    if (valid.length === 0) {
      // webkitGetAsEntry が使えない環境。ファイルだけ受け取る
      if (plainFiles.length === 1 && /\.zip$/i.test(plainFiles[0].name))
        return openZipFile(plainFiles[0]);
      return openSource(
        'ドロップしたファイル',
        fromFiles(plainFiles.map((f) => ({ path: f.name, file: f }))),
      );
    }
    const collected = [];
    for (const entry of valid) await collectEntry(entry, collected, plainFiles);
    const name = valid.length === 1 ? valid[0].name : 'ドロップしたファイル';
    return openSource(name, fromFiles(collected));
  }

  function entryFile(entry) {
    return new Promise((resolve, reject) => entry.file(resolve, reject));
  }

  function readAllEntries(dirEntry) {
    const reader = dirEntry.createReader();
    const all = [];
    return new Promise((resolve, reject) => {
      // readEntries は一度に全部を返さないことがあるので、空になるまで呼ぶ
      const next = () =>
        reader.readEntries((batch) => {
          if (batch.length === 0) resolve(all);
          else {
            all.push(...batch);
            next();
          }
        }, reject);
      next();
    });
  }

  // plainFiles はドロップした一番上のファイル。entry.file() が失敗したら同じ名前のものに替える
  async function collectEntry(entry, out, plainFiles = []) {
    const path = C.normalizePath(entry.fullPath || entry.name);
    if (C.isIgnored(entry.isDirectory ? `${path}/x` : path)) return;
    if (entry.isFile) {
      out.push({ path, file: await entryFileOr(entry, plainFiles) });
    } else if (entry.isDirectory) {
      for (const child of await readAllEntries(entry)) await collectEntry(child, out);
    }
  }

  async function entryFileOr(entry, plainFiles) {
    try {
      return await entryFile(entry);
    } catch (error) {
      const plain = plainFiles.find((f) => f.name === entry.name);
      if (plain) return plain;
      throw error;
    }
  }

  // ---- ファイルの集まり ---------------------------------------------------

  function fromFiles(entries) {
    const files = new Map();
    for (const { path, file } of entries) {
      const p = C.normalizePath(path);
      if (!p || C.isIgnored(p)) continue;
      files.set(p, { read: async () => new Uint8Array(await file.arrayBuffer()) });
    }
    return files;
  }

  async function fromZip(arrayBuffer) {
    const zip = await JSZip.loadAsync(arrayBuffer, { decodeFileName: C.decodeFileName });
    const files = new Map();
    zip.forEach((relativePath, file) => {
      if (file.dir) return;
      const p = C.normalizePath(relativePath);
      if (!p || C.isIgnored(p)) return;
      files.set(p, { read: () => file.async('uint8array') });
    });
    return files;
  }

  async function openZipFile(file) {
    return openSource(file.name, await fromZip(await file.arrayBuffer()));
  }

  async function openSource(name, files) {
    sourceSeq += 1;
    source = { id: sourceSeq, name, files };
    paths = Array.from(files.keys()).sort();
    listedPaths = paths.filter((p) => ['markdown', 'text'].includes(C.kindOf(p)));
    currentPath = null;
    folderStates = {};
    $('source-name').textContent = `${name}（${paths.length} ファイル）`;

    const first = C.findReadme(paths.filter((p) => C.kindOf(p) === 'markdown')) || listedPaths[0];
    if (!first) {
      displayFileList();
      showError('Markdown（.md）もテキストファイルも見つかりませんでした。');
      return;
    }
    await navigate(first, '', { replace: true });
  }

  async function readText(path) {
    return C.decodeBytes(await source.files.get(path).read());
  }

  async function objectUrlOf(path) {
    const bytes = await source.files.get(path).read();
    const url = URL.createObjectURL(new Blob([bytes], { type: C.mimeOf(path) }));
    objectUrls.push(url);
    return url;
  }

  // ---- 移動と履歴 ---------------------------------------------------------

  // ブラウザの「戻る／進む」で文書間を行き来できるよう、移動のたびに履歴へ積む。
  // 履歴には開いた zip・フォルダの番号を持たせ、別のものを開いた後の古い履歴は無視する
  let sourceSeq = 0;

  async function navigate(path, anchor, options) {
    const opts = options || {};
    if (!opts.fromHistory) {
      const state = { source: source.id, path, anchor: anchor || '' };
      if (opts.replace) history.replaceState(state, '');
      else history.pushState(state, '');
    }
    await openPath(path, anchor || '');
  }

  window.addEventListener('popstate', (e) => {
    const s = e.state;
    if (!s || !source || s.source !== source.id) return;
    guarded(() => navigate(s.path, s.anchor, { fromHistory: true }));
  });

  async function openPath(path, anchor) {
    if (path === currentPath && contentEl.dataset.path === path) {
      scrollToAnchor(anchor);
      return;
    }
    const seq = ++renderSeq;
    closeZoom();
    const isFile = source.files.has(path);
    currentPath = path;
    displayFileList();

    const view = document.createElement('div');
    let afterAttach = null;
    if (!isFile) {
      renderListing(view, path);
    } else {
      const kind = C.kindOf(path);
      if (kind === 'markdown') afterAttach = await renderMarkdown(view, path);
      else if (kind === 'text') await renderText(view, path);
      else if (kind === 'image') await renderImage(view, path);
      else await renderOther(view, path);
    }
    if (seq !== renderSeq) return; // もっと新しい表示要求が来ている

    releaseObjectUrlsExcept(view);
    contentEl.replaceChildren(...view.childNodes);
    contentEl.dataset.path = path;
    document.title = `${C.baseName(path) || source.name} - Markdown Viewer`;
    watchTables();
    if (afterAttach) await afterAttach();
    scrollToAnchor(anchor);
  }

  // 新しい表示が使っている URL だけ残す
  function releaseObjectUrlsExcept(view) {
    const used = new Set(
      Array.from(view.querySelectorAll('[src^="blob:"], [href^="blob:"]')).map(
        (el) => el.getAttribute('src') || el.getAttribute('href'),
      ),
    );
    const keep = [];
    for (const url of objectUrls) {
      if (used.has(url)) keep.push(url);
      else URL.revokeObjectURL(url);
    }
    objectUrls = keep;
  }

  function scrollToAnchor(anchor) {
    if (!anchor) {
      scrollEl.scrollTop = 0;
      return;
    }
    const target = findAnchorTarget(contentEl, anchor);
    if (target) target.scrollIntoView({ block: 'start' });
    else scrollEl.scrollTop = 0;
  }

  // 見出しの ID は GitHub と同じく "user-content-" を前に付けて振ってある（画面の要素 ID とぶつけないため）。
  // リンク側の書き方の揺れ（大文字、見出しの文字そのまま）も拾う。
  function findAnchorTarget(root, anchor) {
    const candidates = [anchor, anchor.toLowerCase(), C.slugify(anchor)];
    for (const c of candidates) {
      const el =
        root.querySelector(`[id="${CSS.escape(`user-content-${c}`)}"]`) ||
        root.querySelector(`[id="${CSS.escape(c)}"]`);
      if (el) return el;
    }
    return null;
  }

  // ---- 表示 ---------------------------------------------------------------

  // 描画結果は DOMPurify で無害化してから DOM にする。
  // Mermaid の描画は DOM に入れた後でないと寸法が取れないので、afterAttach として返す。
  async function renderMarkdown(view, path) {
    const { text, encoding } = await readText(path);
    const html = marked.parse(text, { gfm: true });
    const fragment = DOMPurify.sanitize(html, { RETURN_DOM_FRAGMENT: true });
    view.appendChild(fragment);

    if (encoding !== 'utf-8')
      addNotice(view, `文字コードを ${encodingLabel(encoding)} として読みました。`);

    // 見出しに ID を振る
    const slugger = C.createSlugger();
    for (const h of view.querySelectorAll('h1, h2, h3, h4, h5, h6')) {
      h.id = `user-content-${slugger.slug(h.textContent)}`;
    }

    // 短い列は折り返さない。長い列（説明など）があると、日本語の短い列は 1〜2 字の幅まで縮んで縦書きになる
    for (const table of view.querySelectorAll('table')) {
      const rows = [...table.rows].map((r) => [...r.cells].map((c) => c.textContent.trim()));
      for (const i of C.shortColumns(rows, NOWRAP_WIDTH)) {
        for (const r of table.rows) r.cells[i]?.classList.add('nowrap');
      }
    }

    // ```mermaid を図にする（marked が language-mermaid の code にしたものを置き換える）
    const mermaidNodes = [];
    for (const code of view.querySelectorAll('pre > code.language-mermaid')) {
      const div = document.createElement('div');
      div.className = 'mermaid';
      div.textContent = code.textContent;
      code.parentElement.replaceWith(div);
      mermaidNodes.push(div);
    }
    if (!hasMermaid && mermaidNodes.length > 0) {
      addNotice(view, 'Mermaid を読み込めなかったため、図はソースのまま表示しています。');
    }

    const dir = C.dirOf(path);
    rewriteLinks(view, dir);
    await rewriteImages(view, dir);

    if (!hasMermaid || mermaidNodes.length === 0) return null;
    return async () => {
      try {
        await mermaid.run({ nodes: mermaidNodes, suppressErrors: true });
      } catch (error) {
        console.error('Mermaid の描画に失敗しました', error);
      }
      decorateDiagrams(mermaidNodes);
    };
  }

  // ---- 表の幅 -------------------------------------------------------------
  // 文章は読みやすい幅（980px）のままにし、本文の直下の表だけは窓の幅まで広げる（CSS の max-width: 100cqw）。
  // リストや引用の中の表は字下げの分だけ右にずれているので広げない（親の幅のまま）。
  // 本文より広くなった表は、はみ出した分の半分だけ左へずらして本文の中央に揃える。

  const NOWRAP_WIDTH = 30; // 半角 30 字（全角 15 字）以下のセルだけの列は折り返さない

  function centerWideTables() {
    for (const table of contentEl.querySelectorAll(':scope > table')) {
      table.style.marginLeft = '';
      const extra = table.offsetWidth - contentEl.clientWidth;
      if (extra > 0) table.style.marginLeft = `${-extra / 2}px`;
    }
  }
  window.addEventListener('resize', centerWideTables);

  // 表の中の画像が後から読み込まれると、表の幅が変わる。表の大きさが変わったら揃え直す
  const tableObserver =
    typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(centerWideTables);

  function watchTables() {
    centerWideTables();
    if (!tableObserver) return;
    tableObserver.disconnect();
    for (const table of contentEl.querySelectorAll(':scope > table')) tableObserver.observe(table);
  }

  // ---- 図の拡大表示 -------------------------------------------------------
  // Mermaid の SVG は本文の幅に縮められる（max-width: 100%）。横に広い図は字が読めなくなるので、
  // 縮んで表示されている図に「拡大」を付け、押すと原寸で全画面に開く。

  const zoomEl = $('diagram-zoom');
  const zoomStage = $('diagram-zoom-stage');
  let zoomSvg = null;
  let zoomBase = null;
  let zoomScale = 1;

  // 原寸の大きさ。Mermaid の SVG は viewBox に描いた大きさを持っている
  function naturalSize(svg) {
    const vb = svg.viewBox?.baseVal;
    if (vb?.width) return { width: vb.width, height: vb.height };
    const r = svg.getBoundingClientRect();
    return { width: r.width, height: r.height };
  }

  function isShrunk(svg) {
    return naturalSize(svg).width > svg.getBoundingClientRect().width + 1;
  }

  function decorateDiagrams(nodes) {
    for (const node of nodes) {
      const svg = node.querySelector('svg');
      if (!svg) continue;
      node.classList.add('diagram');
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'diagram-zoom-button';
      button.textContent = '拡大';
      button.title = '原寸で開く';
      button.addEventListener('click', (e) => {
        e.stopPropagation();
        openZoom(svg);
      });
      node.appendChild(button);
      node.addEventListener('click', () => {
        if (node.classList.contains('shrunk')) openZoom(svg);
      });
    }
    updateShrunk();
  }

  // 窓の幅が変わると、縮んでいるかどうかも変わる
  function updateShrunk() {
    for (const node of contentEl.querySelectorAll('.diagram')) {
      const svg = node.querySelector('svg');
      node.classList.toggle('shrunk', !!svg && isShrunk(svg));
    }
  }
  window.addEventListener('resize', updateShrunk);

  function openZoom(svg) {
    zoomBase = naturalSize(svg);
    zoomSvg = svg.cloneNode(true);
    zoomSvg.removeAttribute('style'); // Mermaid が付けた max-width を外す
    zoomStage.replaceChildren(zoomSvg);
    zoomEl.hidden = false;
    setZoom(1);
    zoomStage.scrollTo(0, 0);
    zoomEl.focus();
  }

  // 画面に収まる倍率（原寸より大きくはしない）
  function fitScale() {
    const width = zoomStage.clientWidth - 32;
    const height = zoomStage.clientHeight - 32;
    return Math.min(width / zoomBase.width, height / zoomBase.height, 1);
  }

  // 下限は 10%。ただし画面の 10 倍より大きい図は、収まる倍率まで縮められるようにする
  function setZoom(scale) {
    if (!zoomSvg) return;
    zoomScale = Math.min(4, Math.max(Math.min(0.1, fitScale()), scale));
    zoomSvg.setAttribute('width', String(zoomBase.width * zoomScale));
    zoomSvg.setAttribute('height', String(zoomBase.height * zoomScale));
    $('diagram-zoom-level').textContent = `${Math.round(zoomScale * 100)}%`;
  }

  function fitZoom() {
    setZoom(fitScale());
  }

  function closeZoom() {
    if (zoomEl.hidden) return;
    zoomEl.hidden = true;
    zoomStage.replaceChildren();
    zoomSvg = null;
  }

  zoomEl.addEventListener('click', (e) => {
    const action = e.target.closest('[data-zoom]')?.dataset.zoom;
    if (action === 'in') setZoom(zoomScale * 1.25);
    else if (action === 'out') setZoom(zoomScale / 1.25);
    else if (action === 'reset') setZoom(1);
    else if (action === 'fit') fitZoom();
    else if (action === 'close') closeZoom();
  });

  zoomEl.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeZoom();
    else if (e.key === '+' || e.key === ';') setZoom(zoomScale * 1.25);
    else if (e.key === '-') setZoom(zoomScale / 1.25);
    else if (e.key === '0') setZoom(1);
  });

  // Ctrl＋ホイールで拡大・縮小（ブラウザ全体の拡大は止める）
  zoomStage.addEventListener(
    'wheel',
    (e) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      setZoom(zoomScale * (e.deltaY < 0 ? 1.1 : 1 / 1.1));
    },
    { passive: false },
  );

  function rewriteLinks(view, dir) {
    for (const a of view.querySelectorAll('a[href]')) {
      const raw = a.getAttribute('href');
      if (!raw) continue;

      // 外部へのリンクは別のタブで開く（このページから離れて、開いたファイルを失わないように）
      if (C.isExternal(raw)) {
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        continue;
      }

      const { path: rel, anchor } = C.splitHref(raw);
      if (rel === '') {
        // 同じ文書の中の節
        a.setAttribute('href', '#');
        a.dataset.anchor = anchor;
        if (anchor && !findAnchorTarget(view, anchor))
          markBroken(a, `この文書に節が見つかりません: #${anchor}`);
        continue;
      }

      const target = resolveTarget(dir, rel);
      a.setAttribute('href', '#');
      if (target) {
        a.dataset.target = target;
        a.dataset.anchor = anchor;
        a.title = target;
      } else {
        markBroken(a, `リンク先が見つかりません: ${C.resolvePath(dir, rel)}`);
      }
    }
  }

  // 相対リンクの行き先。ファイル → フォルダ → （.md だけ）ファイル名での救済、の順に探す
  function resolveTarget(dir, rel) {
    const resolved = C.resolvePath(dir, rel);
    if (source.files.has(resolved)) return resolved;
    if (C.isDirectory(paths, resolved)) return resolved;
    if (C.kindOf(resolved) === 'markdown') {
      const name = C.baseName(resolved);
      return paths.find((p) => p === name || p.endsWith(`/${name}`)) || null;
    }
    return null;
  }

  function markBroken(a, message) {
    a.classList.add('broken-link');
    a.title = message;
    delete a.dataset.target;
    delete a.dataset.anchor;
  }

  // 相対パスの画像は、読み込みを終えてから表示する（最初の画面で欠けないように）
  async function rewriteImages(view, dir) {
    const tasks = [];
    for (const img of view.querySelectorAll('img[src]')) {
      const raw = img.getAttribute('src');
      if (!raw || C.isExternal(raw)) continue; // data: と外部はそのまま
      const resolved = C.resolvePath(dir, C.splitHref(raw).path);
      if (source.files.has(resolved)) {
        tasks.push(objectUrlOf(resolved).then((url) => img.setAttribute('src', url)));
      } else {
        img.removeAttribute('src');
        img.classList.add('broken-image');
        img.title = `画像が見つかりません: ${resolved}`;
      }
    }
    await Promise.all(tasks);
  }

  async function renderText(view, path) {
    const { text, encoding } = await readText(path);
    addPath(view, path, encoding);
    const pre = document.createElement('pre');
    pre.className = 'plain-text';
    pre.textContent = text;
    view.appendChild(pre);
  }

  async function renderImage(view, path) {
    addPath(view, path);
    const img = document.createElement('img');
    img.alt = C.baseName(path);
    img.src = await objectUrlOf(path);
    view.appendChild(img);
  }

  async function renderOther(view, path) {
    addPath(view, path);
    const p = document.createElement('p');
    p.textContent = 'このファイルはビューアでは表示できません。';
    const a = document.createElement('a');
    a.href = await objectUrlOf(path);
    a.download = C.baseName(path);
    a.textContent = `${C.baseName(path)} を保存する`;
    view.append(p, a);
  }

  function renderListing(view, dir) {
    const h1 = document.createElement('h1');
    h1.textContent = `${C.baseName(dir) || source.name}/`;
    view.appendChild(h1);
    addPath(view, `${dir}/`);

    const { dirs, files } = C.listDirectory(paths, dir);
    const ul = document.createElement('ul');
    ul.className = 'listing';
    if (dir !== '') {
      const parent = dir.includes('/') ? dir.substring(0, dir.lastIndexOf('/')) : '';
      ul.appendChild(listingItem('📁 ..', parent));
    }
    for (const d of dirs) ul.appendChild(listingItem(`📁 ${C.baseName(d)}/`, d));
    for (const f of files) ul.appendChild(listingItem(`📄 ${C.baseName(f)}`, f));
    view.appendChild(ul);
  }

  function listingItem(label, target) {
    const li = document.createElement('li');
    const a = document.createElement('a');
    a.href = '#';
    a.textContent = label;
    a.dataset.target = target;
    a.dataset.anchor = '';
    li.appendChild(a);
    return li;
  }

  function addPath(view, path, encoding) {
    const div = document.createElement('div');
    div.className = 'doc-path';
    div.textContent =
      encoding && encoding !== 'utf-8' ? `${path}（${encodingLabel(encoding)}）` : path;
    view.appendChild(div);
  }

  function addNotice(view, message) {
    const div = document.createElement('div');
    div.className = 'warn-banner';
    div.textContent = message;
    view.prepend(div);
  }

  function encodingLabel(encoding) {
    return (
      { shift_jis: 'Shift_JIS', 'utf-16le': 'UTF-16', 'utf-16be': 'UTF-16' }[encoding] || encoding
    );
  }

  // 文書内のリンク（一か所で受ける）
  contentEl.addEventListener('click', (e) => {
    const a = e.target.closest('a');
    if (!a || !contentEl.contains(a)) return;
    if (a.classList.contains('broken-link')) {
      e.preventDefault();
      return;
    }
    if (a.dataset.target !== undefined) {
      e.preventDefault();
      guarded(() => navigate(a.dataset.target, a.dataset.anchor));
    } else if (a.dataset.anchor !== undefined) {
      e.preventDefault();
      guarded(() => navigate(currentPath, a.dataset.anchor));
    }
  });

  // ---- サイドバー ---------------------------------------------------------

  $('search-box').addEventListener('input', (e) => {
    searchFilter = e.target.value.trim().toLowerCase();
    displayFileList();
  });

  function displayFileList() {
    const fileList = $('file-list');
    fileList.replaceChildren();
    const files = searchFilter
      ? listedPaths.filter((p) => p.toLowerCase().includes(searchFilter))
      : listedPaths;
    renderTree(buildTree(files), fileList, '');
    const active = fileList.querySelector('.file-item.active');
    if (active) active.scrollIntoView({ block: 'nearest' });
  }

  // { dirs: Map<名前, node>, files: [path] }。フォルダ名とキーがぶつからないよう Map で持つ
  function buildTree(files) {
    const tree = { dirs: new Map(), files: [] };
    for (const path of files) {
      const parts = path.split('/');
      let node = tree;
      for (const part of parts.slice(0, -1)) {
        if (!node.dirs.has(part)) node.dirs.set(part, { dirs: new Map(), files: [] });
        node = node.dirs.get(part);
      }
      node.files.push(path);
    }
    return tree;
  }

  // 第 3 引数は folderPath。グローバルの currentPath と名前をぶつけない（旧版の強調表示の不具合の原因）
  function renderTree(node, container, folderPath) {
    const folders = Array.from(node.dirs.keys()).sort();
    for (const folder of folders) {
      const thisPath = folderPath ? `${folderPath}/${folder}` : folder;
      const folderDiv = document.createElement('div');
      folderDiv.className = 'folder';

      const containsCurrent =
        currentPath && (currentPath === thisPath || currentPath.startsWith(`${thisPath}/`));
      const isOpen = !!searchFilter || containsCurrent || folderStates[thisPath] || false;

      const header = document.createElement('div');
      header.className = 'folder-header';
      const icon = document.createElement('span');
      icon.className = 'folder-icon';
      icon.textContent = isOpen ? '▼' : '▶';
      header.append(icon, document.createTextNode(folder)); // ファイル名は textContent で入れる

      const content = document.createElement('div');
      content.className = `folder-content${isOpen ? ' open' : ''}`;

      header.addEventListener('click', () => {
        const willBeOpen = !content.classList.contains('open');
        content.classList.toggle('open');
        icon.textContent = willBeOpen ? '▼' : '▶';
        folderStates[thisPath] = willBeOpen;
      });

      folderDiv.append(header, content);
      container.appendChild(folderDiv);
      renderTree(node.dirs.get(folder), content, thisPath);
    }

    for (const path of node.files.slice().sort()) {
      const div = document.createElement('div');
      div.className = 'file-item';
      const name = C.baseName(path);
      if (/^readme\.(md|markdown)$/i.test(name)) div.classList.add('readme');
      if (C.kindOf(path) === 'text') div.classList.add('text');
      if (path === currentPath) div.classList.add('active');
      div.textContent = name;
      div.title = path;
      div.addEventListener('click', () => guarded(() => navigate(path, '')));
      container.appendChild(div);
    }
  }

  // ---- このビューアについて -----------------------------------------------

  $('about-link').addEventListener('click', (e) => {
    e.preventDefault();
    const build = $('build-info')?.textContent || '';
    const licenses = $('third-party-licenses')?.textContent || '';
    const view = document.createElement('div');
    const h1 = document.createElement('h1');
    h1.textContent = 'Markdown Viewer';
    const p = document.createElement('p');
    p.textContent = build.includes('{{') ? '開発版（src/viewer.html）' : build;
    const pre = document.createElement('pre');
    pre.className = 'plain-text';
    pre.textContent =
      licenses.trim() ||
      '同梱ライブラリのライセンスはビルド版に埋め込まれます（vendor/licenses/）。';
    const h2 = document.createElement('h2');
    h2.textContent = '同梱ライブラリのライセンス';
    view.append(h1, p, h2, pre);
    contentEl.replaceChildren(...view.childNodes);
    delete contentEl.dataset.path;
    currentPath = null;
    displayFileList();
    scrollEl.scrollTop = 0;
  });

  // ---- エラー -------------------------------------------------------------

  async function guarded(fn) {
    try {
      await fn();
    } catch (error) {
      console.error(error);
      showError(`読み込みに失敗しました: ${error?.message ? error.message : error}`);
    }
  }

  function showError(message) {
    const div = document.createElement('div');
    div.className = 'error';
    div.style.whiteSpace = 'pre-wrap';
    div.textContent = message;
    contentEl.replaceChildren(div);
    delete contentEl.dataset.path;
  }

  // テストから使う入口
  window.MdvApp = {
    openZipBuffer: (buffer, name) =>
      fromZip(buffer).then((files) => openSource(name || 'test.zip', files)),
    navigate: (path, anchor) => navigate(path, anchor || ''),
    get currentPath() {
      return currentPath;
    },
  };
})();
