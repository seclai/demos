// Service worker: injects the player into the page and makes all Seclai API
// calls, so the API key never touches the web page.

const BASE = 'https://api.seclai.com';
// One Seclai agent per voice (a Seclai switch step ran every branch, so the
// voice can't be picked inside a single agent). These are the defaults; the
// Options page can override them with agents imported into your own account.
const VOICE_AGENTS = {
  nova: '6ecece33-997a-4143-ab16-930425c8dd99',
  shimmer: 'a4c25414-3d01-409d-a1cc-3677f6685760',
  onyx: '3cfbf87b-ca06-4e05-a37d-fc8389f80aaf',
};

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.id) return;
  const { apiKey } = await chrome.storage.local.get('apiKey');
  if (!apiKey) {
    chrome.runtime.openOptionsPage();
    return;
  }
  try {
    await chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: ['content.css'] });
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['align.js', 'content.js'] });
  } catch (err) {
    // chrome:// pages, the Web Store, etc. can't be scripted.
    console.warn('[read-aloud] could not inject into this tab:', err);
  }
});

// The content script drives polling with one short message per API call; each
// message wakes the service worker, so it never idles out mid-run.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  handle(msg).then(sendResponse, (err) => sendResponse({ error: String(err?.message || err) }));
  return true; // async response
});

async function handle(msg) {
  const cfg = msg.type === 'saveFile' ? null : await settings();
  switch (msg.type) {
    case 'startRun': {
      const voice = VOICE_AGENTS[msg.voice] ? msg.voice : 'nova';
      const agentId = cfg.agentIds[voice] || VOICE_AGENTS[voice];
      const res = await api(`/agents/${agentId}/runs`, cfg, {
        method: 'POST',
        body: JSON.stringify({ input: msg.text, priority: false, metadata: { source: 'read-aloud-extension' } }),
      });
      const run = await res.json();
      return { runId: run.run_id };
    }
    case 'getRun': {
      const res = await api(`/agents/runs/${encodeURIComponent(msg.runId)}`, cfg);
      const run = await res.json();
      return { status: run.status, attachments: run.attachments || [], errorCount: run.error_count };
    }
    case 'download': {
      // Only ever send the key to Seclai.
      if (!String(msg.url).startsWith(BASE + '/')) throw new Error('Refusing to download from a non-Seclai URL.');
      const res = await api(msg.url, cfg);
      const buf = await res.arrayBuffer();
      return { base64: toBase64(buf), mime: res.headers.get('content-type') || 'audio/mpeg' };
    }
    case 'saveFile': {
      // Downloads started from inside a web page can be silently blocked
      // (Brave does this), so hand the file to the browser's download manager.
      const id = await chrome.downloads.download({
        url: `data:audio/mpeg;base64,${msg.base64}`,
        filename: msg.filename,
      });
      return { id };
    }
    default:
      throw new Error(`Unknown message type: ${msg.type}`);
  }
}

async function settings() {
  const { apiKey, agentIds = {} } = await chrome.storage.local.get(['apiKey', 'agentIds']);
  if (!apiKey) throw new Error('No Seclai API key set. Right-click the extension icon → Options.');
  return { apiKey, agentIds };
}

async function api(pathOrUrl, { apiKey }, init = {}) {
  const url = pathOrUrl.startsWith('http') ? pathOrUrl : BASE + pathOrUrl;
  const headers = { 'X-API-Key': apiKey };
  if (init.body) headers['Content-Type'] = 'application/json';
  const res = await fetch(url, { ...init, headers });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Seclai API ${res.status}: ${text.slice(0, 300)}`);
  }
  return res;
}

function toBase64(buf) {
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}
