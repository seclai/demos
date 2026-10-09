const $ = (id) => document.getElementById(id);
const VOICES = ['nova', 'shimmer', 'onyx'];

chrome.storage.local.get(['apiKey', 'agentIds']).then(({ apiKey, agentIds = {} }) => {
  $('apiKey').value = apiKey || '';
  for (const v of VOICES) $(`agent-${v}`).value = agentIds[v] || '';
});

$('save').addEventListener('click', async () => {
  const agentIds = {};
  for (const v of VOICES) {
    const id = $(`agent-${v}`).value.trim();
    if (id) agentIds[v] = id;
  }
  await chrome.storage.local.set({ apiKey: $('apiKey').value.trim(), agentIds });
  $('status').textContent = 'Saved.';
  setTimeout(() => ($('status').textContent = ''), 2000);
});
