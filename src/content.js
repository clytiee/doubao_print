/*
 * 豆包会话打印 — content script
 *
 * 问题：分享页 (https://www.doubao.com/thread/xxx) 的对话内容被装在一个
 * `div.flex-1.overflow-y-scroll` 的滚动容器里（容器只有视口高度，内容却有一万多像素），
 * 打印时溢出部分被裁掉，所以只会打出一页。
 *
 * 做法：打印前沿内容根节点向上逐级解除 height / overflow 限制（并保存原值，打印后还原），
 * 隐藏与对话无关的界面元素，补充分页、图片、代码块等打印排版规则，再调用 window.print()。
 * 同时接管浏览器自身的 Ctrl+P（beforeprint / afterprint），不点按钮直接打印也能正常输出。
 */
(() => {
  'use strict';
  if (window.__dbprintLoaded) return;
  window.__dbprintLoaded = true;

  const STYLE_ID = 'dbprint-style';
  const ON_CLASS = 'dbprint-on';
  const HIDE_CLASS = 'dbprint-hide';
  const UI_CLASS = 'dbprint-ui';

  /** 打印模式状态：null 表示未进入打印模式 */
  let active = null;
  /** 正在执行“加载全文 → 打印”流程，避免重复点击 */
  let busy = false;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /* ------------------------------------------------------------------ */
  /* 定位内容                                                             */
  /* ------------------------------------------------------------------ */

  function findContentRoot() {
    return (
      document.querySelector('[class*="message-list-root"]') ||
      document.querySelector('[class*="mobile-content"]') ||
      null
    );
  }

  /** 找出真正裁切内容的滚动容器（内容根节点的某个 overflow: auto/scroll 祖先） */
  function findScrollBox(root) {
    let el = root;
    while (el && el !== document.documentElement) {
      const cs = getComputedStyle(el);
      if (/(auto|scroll)/.test(cs.overflowY) && el.scrollHeight > el.clientHeight + 4) return el;
      el = el.parentElement;
    }
    return null;
  }

  function countMessages() {
    return document.querySelectorAll(
      '[data-testid="send_message"], [data-testid="receive_message"], [class*="message-item"]'
    ).length;
  }

  /* ------------------------------------------------------------------ */
  /* 载入全部消息 / 图片                                                   */
  /* ------------------------------------------------------------------ */

  /** 反复滚到底部，直到滚动高度和消息条数不再增长（应对懒加载 / 长会话） */
  async function loadAllMessages(sc) {
    if (!sc) return;
    const startedAt = Date.now();
    const LIMIT = 25000;
    let lastH = -1;
    let stable = 0;

    sc.scrollTop = 0;
    await sleep(250);

    while (Date.now() - startedAt < LIMIT) {
      sc.scrollTop = sc.scrollHeight;
      await sleep(450);
      const h = sc.scrollHeight;
      if (h === lastH) {
        if (++stable >= 2) break;
      } else {
        stable = 0;
      }
      lastH = h;
    }

    sc.scrollTop = 0;
    await sleep(200);
  }

  async function preloadImages() {
    const imgs = Array.from(document.querySelectorAll('img'));
    imgs.forEach((img) => {
      if (img.loading === 'lazy') img.loading = 'eager';
    });
    try {
      if (document.fonts && document.fonts.ready) await document.fonts.ready;
    } catch (e) {
      /* ignore */
    }
    await Promise.race([
      Promise.all(
        imgs.map((img) =>
          img.complete
            ? Promise.resolve()
            : new Promise((res) => {
                const done = () => {
                  img.removeEventListener('load', done);
                  img.removeEventListener('error', done);
                  res();
                };
                img.addEventListener('load', done);
                img.addEventListener('error', done);
                setTimeout(done, 4000);
              })
        )
      ),
      sleep(6000),
    ]);
  }

  /* ------------------------------------------------------------------ */
  /* 打印模式                                                             */
  /* ------------------------------------------------------------------ */

  function enter() {
    if (active) return true;
    const root = findContentRoot();
    if (!root) return false;

    const saved = [];
    const setStyle = (el, prop, val) => {
      saved.push({
        el,
        prop,
        value: el.style.getPropertyValue(prop),
        priority: el.style.getPropertyPriority(prop),
      });
      el.style.setProperty(prop, val, 'important');
    };

    // 1) 沿内容根向上，逐级解除高度与溢出限制
    let node = root;
    while (node) {
      setStyle(node, 'overflow', 'visible');
      setStyle(node, 'overflow-x', 'visible');
      setStyle(node, 'overflow-y', 'visible');
      setStyle(node, 'height', 'auto');
      setStyle(node, 'max-height', 'none');
      setStyle(node, 'min-height', '0');
      setStyle(node, 'flex', '0 1 auto');
      if (node === document.documentElement) break;
      node = node.parentElement;
    }

    // 2) 隐藏与对话无关的界面元素（只在打印时隐藏，见样式表）
    const hiddenEls = [];
    const hide = (el) => {
      if (!el || !el.classList || el.classList.contains(HIDE_CLASS)) return;
      hiddenEls.push(el);
      el.classList.add(HIDE_CLASS);
    };

    const gotoBtn = document.querySelector('[data-testid="thread_share_goto_btn"]');
    if (gotoBtn) hide(gotoBtn.parentElement || gotoBtn);

    [...document.querySelectorAll('.mobile-footer, [class*="mobile-footer"]')].forEach(hide);

    // 内容区以外的 position: fixed 悬浮层（底部工具条、浮窗等）
    [...document.body.querySelectorAll('*')].forEach((el) => {
      if (el.nodeType !== 1) return;
      if (root.contains(el) || el.contains(root)) return;
      if (el.closest('.' + UI_CLASS)) return;
      if (!el.offsetWidth || !el.offsetHeight) return;
      if (getComputedStyle(el).position === 'fixed') hide(el);
    });

    // 3) 记录滚动位置，打印结束后恢复
    const scrollEl =
      document.scrollingElement || document.documentElement;
    const scrollTop = scrollEl ? scrollEl.scrollTop : 0;
    const boxes = [];
    [root, findScrollBox(root)].forEach((el) => {
      if (el) boxes.push({ el, top: el.scrollTop });
    });

    document.documentElement.classList.add(ON_CLASS);

    active = { saved, hiddenEls, scrollTop, boxes };
    return true;
  }

  function exit() {
    if (!active) return;
    const { saved, hiddenEls, scrollTop, boxes } = active;
    active = null;

    document.documentElement.classList.remove(ON_CLASS);

    for (let i = saved.length - 1; i >= 0; i -= 1) {
      const { el, prop, value, priority } = saved[i];
      if (value) el.style.setProperty(prop, value, priority);
      else el.style.removeProperty(prop);
    }

    hiddenEls.forEach((el) => {
      try {
        el.classList.remove(HIDE_CLASS);
      } catch (e) {
        /* ignore */
      }
    });

    boxes.forEach(({ el, top }) => {
      try {
        el.scrollTop = top;
      } catch (e) {
        /* ignore */
      }
    });
    try {
      const sc = document.scrollingElement || document.documentElement;
      if (sc) sc.scrollTop = scrollTop;
    } catch (e) {
      /* ignore */
    }
  }

  async function settleLayout() {
    await sleep(120);
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    await sleep(180);
  }

  /* ------------------------------------------------------------------ */
  /* 主流程                                                               */
  /* ------------------------------------------------------------------ */

  async function printThread() {
    if (busy) return;
    if (!findContentRoot()) {
      status('没有找到会话内容，请在豆包分享页（/thread/…）使用');
      return;
    }

    busy = true;
    const root = findContentRoot();
    const sc = findScrollBox(root);
    const before = countMessages();

    status('正在展开全部消息…');
    try {
      await loadAllMessages(sc);
      await preloadImages();

      const after = countMessages();
      if (after > before) status(`已载入 ${after} 条消息，准备打印…`);

      if (!enter()) {
        status('无法进入打印模式：未找到会话内容容器');
        return;
      }
      await settleLayout();
      window.print();
    } catch (e) {
      console.error('[豆包打印] 失败:', e);
      status('打印准备失败，已尝试直接打印');
      try {
        window.print();
      } catch (err) {
        /* ignore */
      }
    } finally {
      // 正常情况下 afterprint 会还原；这里再兜一层，防止对话框行为差异导致卡在打印模式
      setTimeout(exit, 800);
      busy = false;
      statusOff();
    }
  }

  /* ------------------------------------------------------------------ */
  /* 导出 EPUB                                                            */
  /* ------------------------------------------------------------------ */

  function downloadBlob(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.style.display = 'none';
    document.documentElement.appendChild(a);
    a.click();
    setTimeout(() => {
      a.remove();
      URL.revokeObjectURL(url);
    }, 15000);
  }

  async function exportEpub() {
    if (busy) return;
    const root = findContentRoot();
    if (!root) {
      status('没有找到会话内容，请在豆包分享页（/thread/…）使用');
      return;
    }

    busy = true;
    const sc = findScrollBox(root);
    status('正在收集会话内容…');
    try {
      await loadAllMessages(sc);
      await preloadImages();

      const lib = window.DoubaoEpub;
      if (!lib) throw new Error('EPUB 模块未加载，请重新加载扩展');

      status('正在生成 EPUB…');
      const { blob, fileName, messageCount } = await lib.fromPage();
      downloadBlob(blob, fileName);
      status(`已导出 ${fileName}（${messageCount} 条消息，${Math.round(blob.size / 1024)} KB）`);
      statusOff(3200);
    } catch (e) {
      console.error('[豆包打印] EPUB 导出失败:', e);
      status('导出失败：' + (e && e.message ? e.message : '未知错误'));
      statusOff(4000);
    } finally {
      busy = false;
    }
  }

  /* ------------------------------------------------------------------ */
  /* 页面提示 / 浮动按钮                                                   */
  /* ------------------------------------------------------------------ */

  let statusEl = null;
  let statusTimer = 0;

  function status(text) {
    if (!statusEl) {
      statusEl = document.createElement('div');
      statusEl.className = UI_CLASS + ' dbprint-toast';
      document.documentElement.appendChild(statusEl);
    }
    statusEl.textContent = text;
    statusEl.classList.add('is-visible');
    clearTimeout(statusTimer);
  }

  function statusOff(delay = 1600) {
    if (!statusEl) return;
    clearTimeout(statusTimer);
    statusTimer = setTimeout(() => {
      if (statusEl) statusEl.classList.remove('is-visible');
    }, delay);
  }

  function mountButton() {
    if (document.querySelector('.' + UI_CLASS + '.dbprint-fab')) return;

    // 默认显示；用户可在 chrome.storage.sync 里把 showButton 设为 false 关闭浮动按钮
    const proceed = () => {
      if (document.querySelector('.' + UI_CLASS + '.dbprint-fab')) return;

      const wrap = document.createElement('div');
      wrap.className = UI_CLASS + ' dbprint-fab';

      const makeBtn = (label, title, variant, handler) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'dbprint-fab-btn' + (variant ? ' dbprint-fab-btn-' + variant : '');
        btn.textContent = label;
        btn.title = title;
        btn.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          handler();
        });
        return btn;
      };

      const printBtn = makeBtn('打印全文', '打印整个会话（打印对话框里也可选“另存为 PDF”）', '', printThread);
      const epubBtn = makeBtn('导出 EPUB', '把整个会话导出为 EPUB 电子书', 'ghost', exportEpub);

      const close = document.createElement('button');
      close.type = 'button';
      close.className = 'dbprint-fab-close';
      close.setAttribute('aria-label', '收起');
      close.textContent = '×';
      close.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        wrap.remove();
      });

      wrap.appendChild(printBtn);
      wrap.appendChild(epubBtn);
      wrap.appendChild(close);
      document.documentElement.appendChild(wrap);
    };

    try {
      if (chrome && chrome.storage && chrome.storage.sync) {
        chrome.storage.sync.get({ showButton: true }, (cfg) => {
          if (cfg && cfg.showButton === false) return;
          proceed();
        });
        return;
      }
    } catch (e) {
      /* 非扩展环境（例如手动注入调试）直接显示 */
    }
    proceed();
  }

  /* ------------------------------------------------------------------ */
  /* 样式                                                                 */
  /* ------------------------------------------------------------------ */

  const SCREEN_CSS = `
.${UI_CLASS}.dbprint-fab {
  position: fixed;
  right: 20px;
  bottom: 24px;
  z-index: 2147483000;
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 3px 4px 3px 3px;
  border-radius: 999px;
  background: rgba(255, 255, 255, .92);
  box-shadow: 0 4px 18px rgba(15, 23, 42, .16);
  backdrop-filter: blur(6px);
  border: 1px solid rgba(15, 23, 42, .08);
  font-family: inherit;
}
.${UI_CLASS}.dbprint-fab .dbprint-fab-btn {
  border: 0;
  cursor: pointer;
  padding: 7px 14px;
  border-radius: 999px;
  font-size: 13px;
  line-height: 1.2;
  font-family: inherit;
  color: #fff;
  background: #4e6ef2;
  transition: background .18s ease;
}
.${UI_CLASS}.dbprint-fab .dbprint-fab-btn:hover { background: #3f5fe0; }
.${UI_CLASS}.dbprint-fab .dbprint-fab-btn-ghost {
  margin-left: 4px;
  padding: 6px 13px;
  color: #3f5fe0;
  background: transparent;
  border: 1px solid #c7d0f5;
}
.${UI_CLASS}.dbprint-fab .dbprint-fab-btn-ghost:hover { background: #eef2ff; }
.${UI_CLASS}.dbprint-fab .dbprint-fab-close {
  border: 0;
  cursor: pointer;
  width: 22px;
  height: 22px;
  border-radius: 50%;
  font-size: 14px;
  line-height: 1;
  color: #94a3b8;
  background: transparent;
  font-family: inherit;
}
.${UI_CLASS}.dbprint-fab .dbprint-fab-close:hover { color: #475569; background: rgba(15, 23, 42, .06); }

.${UI_CLASS}.dbprint-toast {
  position: fixed;
  left: 50%;
  bottom: 92px;
  transform: translateX(-50%) translateY(8px);
  z-index: 2147483000;
  padding: 8px 16px;
  border-radius: 8px;
  font-size: 13px;
  line-height: 1.4;
  color: #fff;
  background: rgba(15, 23, 42, .86);
  opacity: 0;
  pointer-events: none;
  transition: opacity .2s ease, transform .2s ease;
  font-family: inherit;
  max-width: 80vw;
}
.${UI_CLASS}.dbprint-toast.is-visible { opacity: 1; transform: translateX(-50%) translateY(0); }

@media print {
  .${UI_CLASS} { display: none !important; }
}
`;

  const PRINT_CSS = `
@media print {
  @page { margin: 12mm 10mm; }

  /* 页面本身不再有“一屏高”的裁切 */
  html.${ON_CLASS},
  html.${ON_CLASS} body {
    overflow: visible !important;
    height: auto !important;
  }

  /* 与对话无关的界面元素 */
  html.${ON_CLASS} .${HIDE_CLASS} { display: none !important; }
  html.${ON_CLASS} [data-testid="thread_share_goto_btn"] { display: none !important; }

  /* 内容不越出纸张 */
  html.${ON_CLASS} img,
  html.${ON_CLASS} svg,
  html.${ON_CLASS} video { max-width: 100% !important; }
  html.${ON_CLASS} pre {
    white-space: pre-wrap !important;
    word-break: break-word !important;
    overflow: visible !important;
  }
  html.${ON_CLASS} table { max-width: 100% !important; }
  html.${ON_CLASS} a { word-break: break-all; }

  /* 分页控制：标题不落在页脚，条目/图片不跨页拆开 */
  html.${ON_CLASS} h1,
  html.${ON_CLASS} h2,
  html.${ON_CLASS} h3,
  html.${ON_CLASS} h4,
  html.${ON_CLASS} h5 { break-after: avoid; page-break-after: avoid; }
  html.${ON_CLASS} li,
  html.${ON_CLASS} tr,
  html.${ON_CLASS} img,
  html.${ON_CLASS} blockquote { break-inside: avoid; page-break-inside: avoid; }
  html.${ON_CLASS} p { orphans: 3; widows: 3; }

  /* 收起状态下被截断的长消息尽量展开 */
  html.${ON_CLASS} [data-send-message-collapsed="true"] { max-height: none !important; }

  /* 打印时保留原有配色 */
  html.${ON_CLASS} body {
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }
}
`;

  function installStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = SCREEN_CSS + PRINT_CSS;
    (document.head || document.documentElement).appendChild(style);
  }

  /* ------------------------------------------------------------------ */
  /* 启动                                                                 */
  /* ------------------------------------------------------------------ */

  installStyles();
  mountButton();

  // 浏览器自带 Ctrl+P：进入打印模式后再交给浏览器出图
  window.addEventListener('beforeprint', () => {
    if (!active && findContentRoot()) enter();
  });
  window.addEventListener('afterprint', () => exit());
  // 打印对话框关闭后窗口重新获得焦点；作为 afterprint 的补充
  window.addEventListener('focus', () => {
    if (active) setTimeout(exit, 400);
  });

  // 工具栏图标 / 快捷键
  if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (msg && msg.type === 'dbprint:print') {
        printThread();
        sendResponse({ ok: true });
        return false;
      }
      if (msg && msg.type === 'dbprint:ping') {
        sendResponse({ ok: true });
        return false;
      }
      return false;
    });
  }

  // 页面刷新后若按钮被关掉，重新安装
  const observer = new MutationObserver(() => {
    if (!document.querySelector('.' + UI_CLASS + '.dbprint-fab')) {
      observer.disconnect();
      setTimeout(mountButton, 800);
    }
  });
  observer.observe(document.documentElement, { childList: true, subtree: false });

  // 调试入口（可在控制台手动验证）
  window.DoubaoPrint = { print: printThread, enter, exit };
})();
