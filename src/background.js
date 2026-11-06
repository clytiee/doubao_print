/* 工具栏图标点击 / 快捷键 → 通知 content script 打印当前会话 */

function sendPrint(tabId) {
  if (!tabId) return;
  chrome.tabs.sendMessage(tabId, { type: 'dbprint:print' }, () => {
    // content script 尚未注入（例如扩展刚安装、页面没刷新）
    if (chrome.runtime.lastError) {
      chrome.tabs.reload(tabId, () => {
        setTimeout(() => {
          chrome.tabs.sendMessage(tabId, { type: 'dbprint:print' }, () => {
            void chrome.runtime.lastError;
          });
        }, 1200);
      });
    }
  });
}

chrome.action.onClicked.addListener((tab) => {
  sendPrint(tab.id);
});

chrome.commands.onCommand.addListener((command) => {
  if (command !== 'print-thread') return;
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs && tabs[0]) sendPrint(tabs[0].id);
  });
});
