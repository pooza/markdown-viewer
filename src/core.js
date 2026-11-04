// 画面に依存しない処理。ブラウザでは window.MdvCore、Node（テスト）では module.exports になる。
((root) => {
  'use strict';

  // ---- 文字コード ---------------------------------------------------------

  // バイト列を文字列にする。BOM を見て、無ければ UTF-8 として読み、
  // UTF-8 として不正なら Shift_JIS（CP932）として読み直す。
  // Windows の古い環境で作られたファイルや、Windows 標準の「圧縮」で作った zip のファイル名を想定。
  function decodeBytes(bytes) {
    const u8 = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes);
    if (u8[0] === 0xef && u8[1] === 0xbb && u8[2] === 0xbf) {
      return { text: new TextDecoder('utf-8').decode(u8.subarray(3)), encoding: 'utf-8' };
    }
    if (u8[0] === 0xff && u8[1] === 0xfe) {
      return { text: new TextDecoder('utf-16le').decode(u8.subarray(2)), encoding: 'utf-16le' };
    }
    if (u8[0] === 0xfe && u8[1] === 0xff) {
      return { text: new TextDecoder('utf-16be').decode(u8.subarray(2)), encoding: 'utf-16be' };
    }
    try {
      return { text: new TextDecoder('utf-8', { fatal: true }).decode(u8), encoding: 'utf-8' };
    } catch (_e) {
      return { text: new TextDecoder('shift_jis').decode(u8), encoding: 'shift_jis' };
    }
  }

  // JSZip の decodeFileName に渡す。UTF-8 フラグの無いファイル名だけがここに来る。
  function decodeFileName(bytes) {
    return decodeBytes(bytes).text;
  }

  // ---- パス ---------------------------------------------------------------

  function normalizePath(path) {
    return path
      .replace(/\\/g, '/')
      .replace(/^(\.\/)+/, '')
      .replace(/^\/+/, '');
  }

  function dirOf(path) {
    return path.substring(0, path.lastIndexOf('/') + 1);
  }

  function baseName(path) {
    return path.replace(/\/+$/, '').split('/').pop();
  }

  // baseDir は末尾が "/" のディレクトリ（ルートは ""）。先頭 "/" はルートからのパスとして扱う。
  function resolvePath(baseDir, relativePath) {
    if (relativePath.startsWith('/')) return normalizePath(relativePath);
    const parts = baseDir.split('/').filter((p) => p);
    for (const part of relativePath.split('/')) {
      if (part === '..') parts.pop();
      else if (part !== '.' && part !== '') parts.push(part);
    }
    return parts.join('/');
  }

  // スキームを持つもの（http:, mailto:, file: …）と "//host" は外部として扱う。
  function isExternal(href) {
    return /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('//');
  }

  function safeDecode(s) {
    try {
      return decodeURIComponent(s);
    } catch (_e) {
      return s;
    }
  }

  // 相対リンクを「パス」と「節（#以降）」に分ける。クエリ文字列は捨てる。
  function splitHref(href) {
    const hashIndex = href.indexOf('#');
    let path = hashIndex >= 0 ? href.substring(0, hashIndex) : href;
    const anchor = hashIndex >= 0 ? safeDecode(href.substring(hashIndex + 1)) : '';
    const queryIndex = path.indexOf('?');
    if (queryIndex >= 0) path = path.substring(0, queryIndex);
    return { path: safeDecode(path), anchor };
  }

  // 一覧に出さないもの。フォルダを丸ごと渡されたときの .git や node_modules など。
  const IGNORED_DIRS = new Set(['.git', '.svn', 'node_modules', '__MACOSX']);
  const IGNORED_FILES = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini']);
  function isIgnored(path) {
    const parts = path.split('/');
    if (IGNORED_FILES.has(parts[parts.length - 1])) return true;
    return parts.slice(0, -1).some((p) => IGNORED_DIRS.has(p));
  }

  // ---- ファイルの種類 ---------------------------------------------------

  const MARKDOWN_EXTS = new Set(['md', 'markdown']);
  const IMAGE_MIME = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    svg: 'image/svg+xml',
    webp: 'image/webp',
    bmp: 'image/bmp',
    ico: 'image/x-icon',
  };
  const TEXT_EXTS = new Set([
    'txt',
    'text',
    'log',
    'csv',
    'tsv',
    'sql',
    'json',
    'xml',
    'yml',
    'yaml',
    'toml',
    'ini',
    'cfg',
    'conf',
    'properties',
    'env',
    'js',
    'mjs',
    'cjs',
    'ts',
    'css',
    'html',
    'htm',
    'rb',
    'py',
    'sh',
    'bat',
    'cmd',
    'ps1',
    'psm1',
    'vbs',
    'bas',
    'cls',
    'frm',
    'gitignore',
    'gitattributes',
    'editorconfig',
    'mmd',
  ]);
  const TEXT_NAMES = new Set([
    'LICENSE',
    'LICENCE',
    'NOTICE',
    'README',
    'CHANGELOG',
    'Makefile',
    'Dockerfile',
  ]);

  function extOf(path) {
    const name = baseName(path);
    const dot = name.lastIndexOf('.');
    return dot >= 0 ? name.substring(dot + 1).toLowerCase() : '';
  }

  // 'markdown' | 'text' | 'image' | 'other'
  function kindOf(path) {
    const ext = extOf(path);
    if (MARKDOWN_EXTS.has(ext)) return 'markdown';
    if (IMAGE_MIME[ext]) return 'image';
    if (TEXT_EXTS.has(ext) || (ext === '' && TEXT_NAMES.has(baseName(path)))) return 'text';
    return 'other';
  }

  function mimeOf(path) {
    return IMAGE_MIME[extOf(path)] || 'application/octet-stream';
  }

  // ---- 一覧 ---------------------------------------------------------------

  function depthOf(path) {
    return path.split('/').length;
  }

  function byDepthThenName(a, b) {
    return depthOf(a) - depthOf(b) || (a < b ? -1 : a > b ? 1 : 0);
  }

  // 最初に開く文書。浅い階層の README → index → 浅い階層の最初の .md の順。
  function findReadme(markdownPaths) {
    const sorted = markdownPaths.slice().sort(byDepthThenName);
    return (
      sorted.find((p) => /^readme\.(md|markdown)$/i.test(baseName(p))) ||
      sorted.find((p) => /^index\.(md|markdown)$/i.test(baseName(p))) ||
      sorted[0] ||
      null
    );
  }

  // dir（末尾 "/" 無し、ルートは ""）がフォルダとして存在するか。
  function isDirectory(paths, dir) {
    const prefix = dir === '' ? '' : `${dir.replace(/\/+$/, '')}/`;
    return paths.some((p) => p.startsWith(prefix));
  }

  // dir の直下にあるフォルダとファイル。
  function listDirectory(paths, dir) {
    const prefix = dir === '' ? '' : `${dir.replace(/\/+$/, '')}/`;
    const dirs = new Set();
    const files = [];
    for (const p of paths) {
      if (!p.startsWith(prefix)) continue;
      const rest = p.substring(prefix.length);
      const slash = rest.indexOf('/');
      if (slash >= 0) dirs.add(prefix + rest.substring(0, slash));
      else files.push(p);
    }
    return { dirs: Array.from(dirs).sort(), files: files.sort() };
  }

  // ---- 見出しの ID --------------------------------------------------------

  // GitHub と同じ規則で見出しの ID を作る（github-slugger 相当）。
  // 小文字にし、文字・数字・結合文字・連結句読点（_）・ハイフン・空白以外を消し、空白をハイフンにする。
  // 同じ ID が続いたら -1, -2 … を付ける。
  function slugify(text) {
    return text
      .toLowerCase()
      .replace(/[^\p{L}\p{M}\p{N}\p{Pc}\- ]/gu, '')
      .replace(/ /g, '-');
  }

  function createSlugger() {
    const seen = Object.create(null);
    return {
      slug(text) {
        const base = slugify(text);
        let result = base;
        while (result in seen) {
          seen[base] += 1;
          result = `${base}-${seen[base]}`;
        }
        seen[result] = 0;
        return result;
      },
    };
  }

  const api = {
    decodeBytes,
    decodeFileName,
    normalizePath,
    dirOf,
    baseName,
    resolvePath,
    isExternal,
    splitHref,
    isIgnored,
    extOf,
    kindOf,
    mimeOf,
    findReadme,
    isDirectory,
    listDirectory,
    slugify,
    createSlugger,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.MdvCore = api;
})(typeof window !== 'undefined' ? window : globalThis);
