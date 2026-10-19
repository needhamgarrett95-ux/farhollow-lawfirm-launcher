// Law Firm Launcher — renderer logic
const $ = id => document.getElementById(id);
let currentStatus = null;
let busy = false;

function render(status) {
  currentStatus = status;
  const dot = $('status-dot');
  const txt = $('status-text');
  const sub = $('status-sub');
  const btn = $('btn-toggle');
  const gate = status.gate || {};
  const checking = !!gate.checking;
  const updatePending = !!gate.updatePending;
  const checkFailed = !!gate.checkFailed;

  if (status.running) {
    dot.className = 'dot running';
    txt.textContent = 'Server is running';
    sub.textContent = `Version ${status.version} · ${status.url}`;
    btn.textContent = 'Stop Server';
    btn.disabled = busy;
  } else if (checking) {
    dot.className = 'dot stopped';
    txt.textContent = 'Checking for updates…';
    sub.textContent = 'Please wait a moment.';
    btn.textContent = 'Checking for updates…';
    btn.disabled = true;
  } else {
    dot.className = 'dot stopped';
    txt.textContent = 'Server is stopped';
    let subText = status.serverFound
      ? `Version ${status.version} · ready to start`
      : 'Server not found — set its location in Settings';
    if (checkFailed) subText += ' · (couldn\u2019t check for updates)';
    sub.textContent = subText;
    btn.textContent = 'Start Server';
    // Gate: an available update blocks Start until installed or skipped.
    // A failed check never blocks.
    btn.disabled = busy || !status.serverFound || updatePending;
  }

  $('server-path').value = status.serverPath || '';
  $('chk-startup').checked = status.startWithWindows;
  $('chk-server-boot').checked = status.startServerOnBoot;
  renderUpdate(status.update, gate);
}

function renderUpdate(u, gate) {
  const card = $('update-card');
  if (!u || !u.available) { card.classList.add('hidden'); return; }
  card.classList.remove('hidden');
  $('update-title').textContent = `Update available: server ${u.version}`;
  $('update-notes').textContent = (u.notes || 'See the release page for details.').slice(0, 600);
  // Show "Skip and start anyway" only while the gate is actively pending.
  const skipBtn = $('btn-skip');
  if (gate && gate.updatePending) skipBtn.classList.remove('hidden');
  else skipBtn.classList.add('hidden');
}

async function refresh() {
  render(await window.launcher.getStatus());
  const lines = await window.launcher.getLogs();
  renderLogs(lines);
}

function renderLogs(lines) {
  const el = $('log');
  el.textContent = lines.length ? lines.join('\n') : '(no server output yet)';
  el.scrollTop = el.scrollHeight;
}

$('btn-toggle').addEventListener('click', async () => {
  if (busy) return;
  busy = true;
  $('btn-toggle').disabled = true;
  const r = currentStatus.running
    ? await window.launcher.stopServer()
    : await window.launcher.startServer();
  if (!r.ok) alert(r.error);
  busy = false;
  await refresh();
});

$('btn-browser').addEventListener('click', () => window.launcher.openBrowser());
$('btn-skip').addEventListener('click', async () => {
  $('btn-skip').disabled = true;
  await window.launcher.skipUpdate();
  $('btn-skip').disabled = false;
  await refresh();
});
$('btn-browse').addEventListener('click', async () => {
  await window.launcher.browseServer();
  await refresh();
});
$('btn-check').addEventListener('click', async () => {
  $('btn-check').disabled = true;
  $('btn-check').textContent = 'Checking…';
  await window.launcher.checkUpdates();
  $('btn-check').disabled = false;
  $('btn-check').textContent = 'Check again';
});
$('btn-update').addEventListener('click', async () => {
  if (!confirm('Install the update now? Your case data is never touched by updates.')) return;
  $('btn-update').disabled = true;
  $('update-progress').classList.remove('hidden');
  const r = await window.launcher.installUpdate();
  $('btn-update').disabled = false;
  if (!r.ok) alert('Update failed: ' + r.error);
  await refresh();
});

$('chk-startup').addEventListener('change', e =>
  window.launcher.setStartWithWindows(e.target.checked));
$('chk-server-boot').addEventListener('change', e =>
  window.launcher.setStartServerOnBoot(e.target.checked));

function bindToggle(btnId, panelId) {
  $(btnId).addEventListener('click', () => {
    const p = $(panelId);
    p.classList.toggle('hidden');
    $(btnId).querySelector('.chev').textContent = p.classList.contains('hidden') ? '▸' : '▾';
  });
}
bindToggle('log-toggle', 'log');
bindToggle('settings-toggle', 'settings');

// Live updates from the main process
window.launcher.onStatus(s => render(s));
window.launcher.onLogs(lines => renderLogs(lines));
// A fresh update event may change the gate (checking -> pending/clear),
// so re-pull full status rather than patching the banner alone.
window.launcher.onUpdate(() => refresh());
window.launcher.onUpdateProgress(p => {
  const wrap = $('update-progress');
  wrap.classList.remove('hidden');
  const labels = {
    downloading: pct => `Downloading update… ${Math.round(pct * 100)}%`,
    installing: () => 'Installing update… (Windows may ask for permission)',
    done: () => 'Update complete.',
    error: () => 'Update failed: ' + (p.error || 'unknown error'),
  };
  $('update-label').textContent = (labels[p.phase] || (() => ''))(p.pct || 0);
  const bar = wrap.querySelector('.progress-bar');
  let fill = bar.querySelector('.fill');
  if (!fill) {
    fill = document.createElement('div');
    fill.className = 'fill';
    fill.style.cssText = 'height:100%;width:0%;background:#b9975b;border-radius:4px;transition:width .2s;';
    bar.appendChild(fill);
  }
  fill.style.width = Math.round((p.pct || 0) * 100) + '%';
});

refresh();
setInterval(refresh, 5000); // gentle polling fallback
