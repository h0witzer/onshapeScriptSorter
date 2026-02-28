const ON_COLOR = "#2fbf4a";
const OFF_COLOR = "#8c8c8c";

function isOnshapeUrl(url) {
  if (!url || typeof url !== "string") return false;
  try {
    const parsed = new URL(url);
    return parsed.hostname === "cad.onshape.com";
  } catch {
    return false;
  }
}

function drawIcon(size, color) {
  const canvas = new OffscreenCanvas(size, size);
  const ctx = canvas.getContext("2d");

  ctx.clearRect(0, 0, size, size);

  const pad = Math.round(size * 0.08);
  const radius = Math.round(size * 0.2);

  // Rounded square background
  ctx.fillStyle = color;
  roundRect(ctx, pad, pad, size - pad * 2, size - pad * 2, radius);
  ctx.fill();

  // White "tree" glyph
  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = Math.max(1.5, size * 0.1);
  ctx.lineCap = "round";

  const x1 = Math.round(size * 0.3);
  const x2 = Math.round(size * 0.7);
  const yTop = Math.round(size * 0.3);
  const yMid = Math.round(size * 0.52);
  const yBot = Math.round(size * 0.72);

  ctx.beginPath();
  ctx.moveTo(x1, yTop);
  ctx.lineTo(x1, yBot);
  ctx.moveTo(x1, yTop);
  ctx.lineTo(x2, yTop);
  ctx.moveTo(x1, yMid);
  ctx.lineTo(x2, yMid);
  ctx.moveTo(x1, yBot);
  ctx.lineTo(x2, yBot);
  ctx.stroke();

  return ctx.getImageData(0, 0, size, size);
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

function setActionIcon(tabId, enabled) {
  const color = enabled ? ON_COLOR : OFF_COLOR;
  const imageData = {
    16: drawIcon(16, color),
    32: drawIcon(32, color)
  };

  chrome.action.setIcon({ tabId, imageData });
}

async function updateTabAction(tabId, url) {
  const enabled = isOnshapeUrl(url);

  if (enabled) {
    await chrome.action.enable(tabId);
    await chrome.action.setTitle({ tabId, title: "Onshape Script Sorter" });
  } else {
    await chrome.action.disable(tabId);
    await chrome.action.setTitle({ tabId, title: "only works on cad.onshape.com" });
  }

  setActionIcon(tabId, enabled);
}

async function refreshActiveTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = tabs[0];
  if (!tab || typeof tab.id !== "number") return;
  await updateTabAction(tab.id, tab.url);
}

chrome.runtime.onInstalled.addListener(() => {
  void refreshActiveTab();
});

chrome.runtime.onStartup.addListener(() => {
  void refreshActiveTab();
});

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  try {
    const tab = await chrome.tabs.get(tabId);
    await updateTabAction(tabId, tab.url);
  } catch {
    // Ignore transient tab errors.
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  const url = changeInfo.url || tab.url;
  if (!url) return;
  void updateTabAction(tabId, url);
});

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab || typeof tab.id !== "number") return;

  try {
    const response = await chrome.tabs.sendMessage(tab.id, { type: "OSSS_OPEN_MANAGER" });
    if (!response?.ok) {
      // Retry once in case content script/UI was still loading.
      await new Promise((resolve) => setTimeout(resolve, 250));
      await chrome.tabs.sendMessage(tab.id, { type: "OSSS_OPEN_MANAGER" });
    }
  } catch {
    // No content script on page or page not ready.
  }
});
