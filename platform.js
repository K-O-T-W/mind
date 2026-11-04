// 平台差异只放在这一处：macOS 的 ⌘、终端里的 python3、路径分隔符。
// 页面上的快捷键提示会在加载后统一换成当前平台的写法；真正处理按键的
// 代码仍然同时接受 Ctrl 和 ⌘，所以两边都能用。
(function () {
  const ua = navigator.userAgent || '';
  const isMac = /Macintosh|Mac OS X|Mac_PowerPC|iPhone|iPad|iPod/i.test(ua)
    || /^Mac/i.test(navigator.platform || '');
  const platform = {
    isMac,
    mod: isMac ? '⌘' : 'Ctrl',
    python: isMac ? 'python3' : 'python',
    sep: isMac ? '/' : '\\',
  };
  window.MIND_PLATFORM = platform;

  if (!isMac) return;

  // 静态文案里的 Ctrl 一次换掉：工具栏 title、帮助层、输入框提示都算。
  // 动态生成的文案在各自的代码里用 MIND_PLATFORM.mod，不走这里。
  function fixLabels(root) {
    if (!root) return;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
    const texts = [];
    while (walker.nextNode()) texts.push(walker.currentNode);
    for (const node of texts) {
      if (node.parentElement && node.parentElement.closest('.keep-ctrl')) continue;
      if (node.nodeValue && node.nodeValue.includes('Ctrl')) {
        node.nodeValue = node.nodeValue.replace(/Ctrl/g, '⌘');
      }
    }
    if (!root.querySelectorAll) return;
    for (const el of root.querySelectorAll('[title], [aria-label], [placeholder]')) {
      for (const attr of ['title', 'aria-label', 'placeholder']) {
        const value = el.getAttribute(attr);
        if (value && value.includes('Ctrl')) {
          el.setAttribute(attr, value.replace(/Ctrl/g, '⌘'));
        }
      }
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => fixLabels(document.body));
  } else {
    fixLabels(document.body);
  }
})();
