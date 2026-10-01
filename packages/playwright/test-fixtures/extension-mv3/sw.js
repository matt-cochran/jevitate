// #256 fixture service worker: records that it ran (the extension loaded).
chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.set({ installed: true });
});
