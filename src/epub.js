/*
 * epub.js — 把豆包会话页的 DOM 转成 EPUB 3 电子书
 *
 * 思路：
 *   1. 用白名单遍历消息 DOM，转成语义化 XHTML（div/span 摊平、按钮和图标丢弃）；
 *   2. 图片尽量抓成二进制内嵌进书里，抓不到就丢掉；
 *   3. 自己写一个 STORE（不压缩）的 zip 打包器，组装 mimetype / container.xml /
 *      content.opf / nav.xhtml / toc.ncx / 章节 xhtml / style.css。
 *   不依赖任何第三方库，方便直接以「加载已解压的扩展程序」运行。
 */
(() => {
  'use strict';
  if (window.DoubaoEpub) return;

  /* ------------------------------------------------------------------ */
  /* HTML → 干净 XHTML                                                    */
  /* ------------------------------------------------------------------ */

  const DROP = new Set([
    'SVG', 'PATH', 'BUTTON', 'SCRIPT', 'STYLE', 'NOSCRIPT', 'INPUT', 'SELECT', 'TEXTAREA',
    'IFRAME', 'VIDEO', 'AUDIO', 'CANVAS', 'LINK', 'META', 'OBJECT', 'EMBED',
  ]);
  const INLINE_OK = new Set([
    'SPAN', 'STRONG', 'EM', 'B', 'I', 'U', 'S', 'DEL', 'CODE', 'A', 'SUP', 'SUB', 'MARK', 'SMALL',
  ]);
  const HEADINGS = new Set(['H1', 'H2', 'H3', 'H4', 'H5', 'H6']);
  const BLOCK_OK = new Set([
    'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'P', 'UL', 'OL', 'LI', 'BLOCKQUOTE', 'PRE',
    'TABLE', 'THEAD', 'TBODY', 'TFOOT', 'TR', 'TD', 'TH', 'HR', 'DL', 'DT', 'DD', 'FIGURE', 'FIGCAPTION',
  ]);
  const CONTAINERS = new Set([
    'DIV', 'SECTION', 'ARTICLE', 'MAIN', 'HEADER', 'FOOTER', 'ASIDE', 'NAV', 'FORM', 'LABEL', 'BODY',
  ]);

  const escText = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const escAttr = (s) => escText(s).replace(/"/g, '&quot;');
  const collapse = (s) => s.replace(/[\t\r\n]+/g, ' ').replace(/ {2,}/g, ' ');

  /** 图片占位：真实二进制在打包阶段再内嵌 */
  function makeImg(el, ctx) {
    const src = el.getAttribute('src') || el.getAttribute('data-src') || '';
    if (!src) return '';
    const alt = escAttr((el.getAttribute('alt') || '').slice(0, 120));
    const idx = ctx.images.push({ src }) - 1;
    return `<img data-dbp-img="${idx}" alt="${alt}"/>`;
  }

  /** 行内内容 */
  function inlineHTML(node, ctx) {
    if (node.nodeType === 3) return escText(collapse(node.nodeValue));
    if (node.nodeType !== 1) return '';
    const tag = node.tagName.toUpperCase();
    if (DROP.has(tag)) return '';
    if (tag === 'IMG') return makeImg(node, ctx);
    if (tag === 'BR') return '<br/>';

    let inner = '';
    for (const child of node.childNodes) inner += inlineHTML(child, ctx);

    if (tag === 'A') {
      const href = node.getAttribute('href') || '';
      if (/^(https?:|mailto:|#)/i.test(href)) return `<a href="${escAttr(href)}">${inner}</a>`;
      return inner;
    }
    if (INLINE_OK.has(tag)) {
      const lower = tag.toLowerCase();
      const textOnly = inner.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, '').trim();
      if (!textOnly && !/<img/i.test(inner)) return '';
      return `<${lower}>${inner}</${lower}>`;
    }
    return inner;
  }

  function inlineOf(el, ctx) {
    let html = '';
    for (const child of el.childNodes) html += inlineHTML(child, ctx);
    return html.trim();
  }

  /** 表格：保留行列 */
  function renderTable(table, ctx) {
    const walk = (node) => {
      if (node.nodeType !== 1) return '';
      const tag = node.tagName.toUpperCase();
      if (tag === 'TR') {
        const cells = [...node.children]
          .filter((c) => /^(TD|TH)$/i.test(c.tagName))
          .map((c) => `<${c.tagName.toLowerCase()}>${inlineOf(c, ctx)}</${c.tagName.toLowerCase()}>`)
          .join('');
        return cells ? `<tr>${cells}</tr>` : '';
      }
      if (tag === 'CAPTION') return inlineOf(node, ctx) ? `<caption>${inlineOf(node, ctx)}</caption>` : '';
      if (/^(THEAD|TBODY|TFOOT)$/.test(tag)) {
        const rows = [...node.children].map(walk).join('');
        return rows ? `<${tag.toLowerCase()}>${rows}</${tag.toLowerCase()}>` : '';
      }
      if (tag === 'TABLE') return [...node.children].map(walk).join('');
      return '';
    };
    return `<table>${[...table.childNodes].map(walk).join('')}</table>`;
  }

  /** 块级内容：容器摊平，文本聚合成 <p> */
  function renderFlow(el, ctx) {
    let html = '';
    let buf = '';
    const flush = () => {
      const t = buf.trim();
      if (t) html += `<p>${t}</p>`;
      buf = '';
    };

    for (const child of el.childNodes) {
      if (child.nodeType === 3) {
        buf += escText(collapse(child.nodeValue));
        continue;
      }
      if (child.nodeType !== 1) continue;

      const tag = child.tagName.toUpperCase();
      if (DROP.has(tag)) continue;
      if (tag === 'BR') {
        buf += '<br/>';
        continue;
      }
      if (tag === 'IMG') {
        flush();
        html += makeImg(child, ctx);
        continue;
      }
      if (CONTAINERS.has(tag)) {
        flush();
        html += renderFlow(child, ctx);
        continue;
      }
      if (tag === 'PRE') {
        flush();
        const code = child.textContent.replace(/^\n+|\s+$/g, '');
        html += `<pre><code>${escText(code)}</code></pre>`;
        continue;
      }
      if (tag === 'HR') {
        flush();
        html += '<hr/>';
        continue;
      }
      if (tag === 'TABLE') {
        flush();
        html += renderTable(child, ctx);
        continue;
      }
      if (HEADINGS.has(tag) || tag === 'TD' || tag === 'TH' || tag === 'FIGCAPTION') {
        flush();
        const inner = inlineOf(child, ctx);
        if (inner) html += `<${tag.toLowerCase()}>${inner}</${tag.toLowerCase()}>`;
        continue;
      }
      if (BLOCK_OK.has(tag)) {
        flush();
        const inner = renderFlow(child, ctx);
        if (inner) html += `<${tag.toLowerCase()}>${inner}</${tag.toLowerCase()}>`;
        continue;
      }
      // 行内
      buf += inlineHTML(child, ctx);
    }
    flush();
    return html;
  }

  /* ------------------------------------------------------------------ */
  /* 收集会话                                                             */
  /* ------------------------------------------------------------------ */

  const plain = (html) => html.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();

  function collectMessages(images) {
    const ctx = { images };
    const items = [...document.querySelectorAll('.message-item')];
    const list = [];

    for (const item of items) {
      const kind = item.getAttribute('data-testid') === 'send_message' ? 'user' : 'ai';
      const content =
        item.querySelector('[data-testid="message_content"]') || item;
      const html = renderFlow(content, ctx);
      if (!plain(html)) continue;
      list.push({ kind, html });
    }
    return list;
  }

  /* ------------------------------------------------------------------ */
  /* EPUB 组装                                                            */
  /* ------------------------------------------------------------------ */

  const CSS = `@charset "utf-8";
body { margin: 0 2%; font-family: "Noto Serif CJK SC", "Songti SC", "Source Han Serif SC", serif;
  line-height: 1.75; color: #1f2328; font-size: 1em; }
h1, h2, h3, h4 { font-family: "Noto Sans CJK SC", "PingFang SC", "Microsoft YaHei", sans-serif;
  line-height: 1.4; margin: 1.4em 0 .7em; }
h1 { font-size: 1.5em; } h2 { font-size: 1.25em; } h3 { font-size: 1.1em; } h4 { font-size: 1em; }
p { margin: 0 0 .85em; }
ul, ol { margin: 0 0 .9em; padding-left: 1.5em; }
li { margin: .2em 0; }
li > p { margin: 0; }
blockquote { margin: 1em 0; padding: .2em 1em; border-left: 3px solid #d0d7de;
  color: #57606a; background: #f8fafc; }
pre { margin: 1em 0; padding: .8em 1em; background: #f6f8fa; border: 1px solid #e5e9ef;
  border-radius: 6px; white-space: pre-wrap; word-wrap: break-word; font-size: .88em; line-height: 1.55; }
code { font-family: "SFMono-Regular", Consolas, monospace; background: #f6f8fa; padding: 0 .2em;
  border-radius: 3px; word-wrap: break-word; }
pre code { background: transparent; padding: 0; }
img { max-width: 100%; height: auto; }
table { width: 100%; border-collapse: collapse; margin: 1em 0; font-size: .92em; }
th, td { border: 1px solid #d0d7de; padding: .4em .6em; text-align: left; vertical-align: top; }
th { background: #f2f5f9; }
hr { border: 0; border-top: 1px solid #e5e9ef; margin: 1.6em 0; }
a { color: #3f5fe0; text-decoration: none; }

.msg { margin: 0 0 1.8em; }
.msg .who { font-size: .82em; letter-spacing: .06em; color: #4e6ef2; margin: 0 0 .5em; }
.msg.ai .who { color: #4e6ef2; }
.msg.user .who { color: #64748b; }
.msg.user .body { border-left: 3px solid #e2e8f0; padding-left: .9em; }
.cover { text-align: center; padding-top: 18%; }
.cover h1 { font-size: 1.9em; margin-bottom: .8em; }
.cover .meta { font-size: .85em; color: #64748b; line-height: 2; }
.chapter-title { font-size: 1.3em; margin: 0 0 1.2em; }
.front-title { font-size: 1.6em; line-height: 1.45; margin: 0 0 1.2em; }`;

  function xhtmlDoc(title, body) {
    return `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="zh-CN" lang="zh-CN">
<head>
<meta charset="utf-8"/>
<title>${escText(title)}</title>
<link rel="stylesheet" type="text/css" href="style.css"/>
</head>
<body>
${body}
</body>
</html>`;
  }

  function groupChapters(msgs) {
    const chapters = [];
    for (const m of msgs) {
      if (m.kind === 'user' || !chapters.length) {
        chapters.push({ items: [] });
      }
      chapters[chapters.length - 1].items.push(m);
    }
    return chapters;
  }

  function chapterLabel(chapter, index) {
    const first = chapter.items.find((i) => i.kind === 'user') || chapter.items[0];
    const text = plain(first ? first.html : '');
    if (!text) return `第 ${index + 1} 段`;
    return text.length > 26 ? `${text.slice(0, 26)}…` : text;
  }

  async function fetchImage(src, budget) {
    if (!src || src.startsWith('data:')) return null;
    if (src.startsWith('blob:')) return null;
    if (budget.used >= budget.max) return null;
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 8000);
      const res = await fetch(src, { signal: ctrl.signal, credentials: 'omit' });
      clearTimeout(timer);
      if (!res.ok) return null;
      const blob = await res.blob();
      if (!blob.size || blob.size > 8 * 1024 * 1024) return null;
      budget.used += blob.size;
      const type = (blob.type || 'image/png').includes('jpeg') ? 'jpg'
        : (blob.type || '').includes('svg') ? 'svg'
        : (blob.type || '').includes('gif') ? 'gif'
        : (blob.type || '').includes('webp') ? 'webp'
        : 'png';
      const buf = new Uint8Array(await blob.arrayBuffer());
      return { data: buf, ext: type };
    } catch (e) {
      return null;
    }
  }

  async function buildEpub(msgs, images, bookTitle) {
    const chapters = groupChapters(msgs);

    // 内嵌图片
    const budget = { used: 0, max: 40 * 1024 * 1024 };
    const imgFiles = [];
    const imgMap = [];
    const uniq = [...new Set(images.map((i) => i.src))];
    for (const src of uniq) {
      const got = await fetchImage(src, budget);
      if (got) {
        const n = imgFiles.length + 1;
        imgFiles.push({ path: `images/img${n}.${got.ext}`, data: got.data });
        imgMap.push({ src, target: `images/img${n}.${got.ext}` });
      }
    }

    function fixImages(html) {
      return html.replace(/<img data-dbp-img="(\d+)" alt="([^"]*)"\/>/g, (all, idxStr, alt) => {
        const item = images[Number(idxStr)];
        if (!item) return '';
        const hit = imgMap.find((m) => m.src === item.src);
        if (!hit) return '';
        return `<img src="${hit.target}" alt="${alt}"/>`;
      });
    }

    const title = bookTitle || '豆包会话';
    const now = new Date();
    const dateStr = `${now.getFullYear()} 年 ${now.getMonth() + 1} 月 ${now.getDate()} 日`;
    const isoNow = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
    const uuid = 'urn:uuid:' + 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
    });

    // 封面 / 前言
    const front = xhtmlDoc(title, `<section class="cover">
<h1>${escText(title)}</h1>
<div class="meta">
<div>对话导出：${escText(dateStr)}</div>
<div>来源：${escText(location.href)}</div>
<div>由豆包会话生成 · 内容由 AI 生成，可能有误</div>
</div>
</section>`);

    // 章节
    const chapFiles = [];
    chapters.forEach((ch, i) => {
      const label = chapterLabel(ch, i);
      const body = ch.items
        .map((m) => `<section class="msg ${m.kind}">
<div class="who">${m.kind === 'user' ? '你' : '豆包'}</div>
<div class="body">${fixImages(m.html)}</div>
</section>`)
        .join('\n');
      chapFiles.push({
        path: `chap${i + 1}.xhtml`,
        title: label,
        html: xhtmlDoc(label, `<article><h1 class="chapter-title">${escText(label)}</h1>\n${body}</article>`),
      });
    });

    const navLis = chapFiles
      .map((c, i) => `    <li><a href="${c.path}">第 ${i + 1} 轮：${escText(c.title)}</a></li>`)
      .join('\n');
    const nav = xhtmlDoc('目录', `<nav epub:type="toc" xmlns:epub="http://www.idpf.org/2007/ops">
<h1>目录</h1>
<ul>
<li><a href="front.xhtml">封面</a></li>
${navLis}
</ul>
</nav>`);

    const ncxPoints = chapFiles
      .map((c, i) => `    <navPoint id="np${i + 1}" playOrder="${i + 1}">
      <navLabel><text>第 ${i + 1} 轮：${escText(c.title)}</text></navLabel>
      <content src="${c.path}"/>
    </navPoint>`)
      .join('\n');

    const tocNcx = `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE ncx PUBLIC "-//NISO//DTD ncx 2005-1//EN" "http://www.daisy.org/z3986/2005/ncx-2005-1.dtd">
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1" xml:lang="zh-CN">
<head>
<meta name="dtb:uid" content="${uuid}"/>
<meta name="dtb:depth" content="1"/>
<meta name="dtb:totalPageCount" content="0"/>
<meta name="dtb:maxPageNumber" content="0"/>
</head>
<docTitle><text>${escText(title)}</text></docTitle>
<navMap>
    <navPoint id="np0" playOrder="0">
      <navLabel><text>封面</text></navLabel>
      <content src="front.xhtml"/>
    </navPoint>
${ncxPoints}
</navMap>
</ncx>`;

    const manifestItems = [
      '    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>',
      '    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>',
      '    <item id="css" href="style.css" media-type="text/css"/>',
      '    <item id="front" href="front.xhtml" media-type="application/xhtml+xml"/>',
      ...chapFiles.map((c, i) => `    <item id="chap${i + 1}" href="${c.path}" media-type="application/xhtml+xml"/>`),
      ...imgFiles.map((f, i) => {
        const type = f.path.endsWith('.svg') ? 'image/svg+xml'
          : f.path.endsWith('.jpg') ? 'image/jpeg'
          : f.path.endsWith('.gif') ? 'image/gif'
          : f.path.endsWith('.webp') ? 'image/webp'
          : 'image/png';
        return `    <item id="img${i + 1}" href="${f.path}" media-type="${type}"/>`;
      }),
    ].join('\n');

    const spineItems = [
      '    <itemref idref="front"/>',
      ...chapFiles.map((c, i) => `    <itemref idref="chap${i + 1}"/>`),
    ].join('\n');

    const opf = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid" xml:lang="zh-CN">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="bookid">${uuid}</dc:identifier>
    <dc:title>${escText(title)}</dc:title>
    <dc:creator>豆包</dc:creator>
    <dc:language>zh-CN</dc:language>
    <dc:source>${escText(location.href)}</dc:source>
    <dc:date>${isoNow}</dc:date>
    <meta property="dcterms:modified">${isoNow}</meta>
  </metadata>
  <manifest>
${manifestItems}
  </manifest>
  <spine toc="ncx">
${spineItems}
  </spine>
</package>`;

    const container = `<?xml version="1.0" encoding="utf-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`;

    const files = [
      { path: 'META-INF/container.xml', text: container },
      { path: 'OEBPS/content.opf', text: opf },
      { path: 'OEBPS/nav.xhtml', text: nav },
      { path: 'OEBPS/toc.ncx', text: tocNcx },
      { path: 'OEBPS/style.css', text: CSS },
      { path: 'OEBPS/front.xhtml', text: front },
      ...chapFiles.map((c) => ({ path: `OEBPS/${c.path}`, text: c.html })),
      ...imgFiles.map((f) => ({ path: `OEBPS/${f.path}`, data: f.data })),
    ];

    const zip = makeZip(files);
    return new Blob([zip], { type: 'application/epub+zip' });
  }

  /* ------------------------------------------------------------------ */
  /* 最小 ZIP 打包器（STORE，无压缩；mimetype 必须是第一个且不压缩）        */
  /* ------------------------------------------------------------------ */

  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let i = 0; i < 256; i += 1) {
      let c = i;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[i] = c >>> 0;
    }
    return t;
  })();

  function crc32(bytes) {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i += 1) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  function dosTime(d) {
    const time = ((d.getHours() & 0x1f) << 11) | ((d.getMinutes() & 0x3f) << 5) | ((d.getSeconds() >> 1) & 0x1f);
    const date = (((d.getFullYear() - 1980) & 0x7f) << 9) | (((d.getMonth() + 1) & 0xf) << 5) | (d.getDate() & 0x1f);
    return { time, date };
  }

  function makeZip(files) {
    const enc = new TextEncoder();
    const now = dosTime(new Date());
    const chunks = [];
    const central = [];
    let offset = 0;

    // mimetype 必须排在第一位
    const ordered = [
      { path: 'mimetype', text: 'application/epub+zip' },
      ...files,
    ];

    for (const f of ordered) {
      const nameBytes = enc.encode(f.path);
      const data = f.data ? f.data : enc.encode(f.text || '');
      const crc = crc32(data);
      const size = data.length;

      const local = new Uint8Array(30 + nameBytes.length + size);
      const lv = new DataView(local.buffer);
      lv.setUint32(0, 0x04034b50, true);
      lv.setUint16(4, 20, true);
      lv.setUint16(6, 0, true);
      lv.setUint16(8, 0, true);           // 存储方式
      lv.setUint16(10, now.time, true);
      lv.setUint16(12, now.date, true);
      lv.setUint32(14, crc, true);
      lv.setUint32(18, size, true);
      lv.setUint32(22, size, true);
      lv.setUint16(26, nameBytes.length, true);
      lv.setUint16(28, 0, true);
      local.set(nameBytes, 30);
      local.set(data, 30 + nameBytes.length);
      chunks.push(local);

      const cen = new Uint8Array(46 + nameBytes.length);
      const cv = new DataView(cen.buffer);
      cv.setUint32(0, 0x02014b50, true);
      cv.setUint16(4, 20, true);
      cv.setUint16(6, 20, true);
      cv.setUint16(8, 0, true);
      cv.setUint16(10, 0, true);
      cv.setUint16(12, now.time, true);
      cv.setUint16(14, now.date, true);
      cv.setUint32(16, crc, true);
      cv.setUint32(20, size, true);
      cv.setUint32(24, size, true);
      cv.setUint16(28, nameBytes.length, true);
      cv.setUint16(30, 0, true);
      cv.setUint16(32, 0, true);
      cv.setUint16(34, 0, true);
      cv.setUint16(36, 0, true);
      cv.setUint32(38, 0, true);
      cv.setUint32(42, offset, true);
      cen.set(nameBytes, 46);
      central.push(cen);

      offset += local.length;
    }

    const cdSize = central.reduce((s, c) => s + c.length, 0);
    const eocd = new Uint8Array(22);
    const ev = new DataView(eocd.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(4, 0, true);
    ev.setUint16(6, 0, true);
    ev.setUint16(8, ordered.length, true);
    ev.setUint16(10, ordered.length, true);
    ev.setUint32(12, cdSize, true);
    ev.setUint32(16, offset, true);
    ev.setUint16(20, 0, true);

    const total = chunks.reduce((s, c) => s + c.length, 0) + cdSize + eocd.length;
    const out = new Uint8Array(total);
    let p = 0;
    for (const c of chunks) {
      out.set(c, p);
      p += c.length;
    }
    for (const c of central) {
      out.set(c, p);
      p += c.length;
    }
    out.set(eocd, p);
    return out;
  }

  /* ------------------------------------------------------------------ */
  /* 对外接口                                                             */
  /* ------------------------------------------------------------------ */

  function fileName(title) {
    const safe = (title || '豆包会话').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 80);
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return `${safe}_${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}.epub`;
  }

  function bookTitle() {
    const fromDoc = (document.title || '').replace(/\s*[-–—]\s*豆包\s*$/, '').trim();
    if (fromDoc && fromDoc !== '豆包') return fromDoc;
    const h1 = document.querySelector('[class*="message-list-root"] h1');
    if (h1 && h1.textContent.trim()) return h1.textContent.trim().slice(0, 60);
    const firstUser = document.querySelector('.message-item[data-testid="send_message"] [data-testid="message_content"]');
    if (firstUser && firstUser.textContent.trim()) return firstUser.textContent.trim().slice(0, 40);
    return '豆包会话';
  }

  async function fromPage() {
    const images = [];
    const msgs = collectMessages(images);
    if (!msgs.length) throw new Error('没有找到会话内容');
    const title = bookTitle();
    const blob = await buildEpub(msgs, images, title);
    return { blob, fileName: fileName(title), messageCount: msgs.length, title };
  }

  window.DoubaoEpub = { fromPage, makeZip, collectMessages };
})();
