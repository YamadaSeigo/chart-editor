// エディタ用：譜面ボードとの連携（config.js の後に読み込む）
// <script src="board.js" data-part="TECH"></script>
// ・ヘッダーに Google ドライブへのリンクと、今の譜面のボード上の状態を出す
// ・開いている譜面（アセット名 = 名前欄）がボードにあれば、定期的に「作成中」と知らせる
(function () {
  'use strict';
  const PART = document.currentScript.dataset.part;
  const CFG = window.CHART_EDITOR_CONFIG || {};
  const USER_KEY = 'ms2026.chartBoard.user';
  const BEAT_MS = 60 * 1000;
  const STATUS_JP = { todo: '未着手', doing: '作成中', review: '確認待ち', done: '完成' };

  const css = document.createElement('style');
  css.textContent = `
.bdlink{display:inline-flex;align-items:center;gap:5px;color:var(--dim);text-decoration:none;border:1px solid var(--line);border-radius:7px;padding:2px 9px;font-size:12px;line-height:18px;white-space:nowrap}
.bdlink:hover{color:var(--text);background:#2e2e3e}
.bdchip{display:inline-flex;align-items:center;gap:6px;font-size:11px;color:var(--dim);white-space:nowrap;max-width:300px;overflow:hidden;text-overflow:ellipsis}
.bdchip .st{border-radius:9px;padding:0 7px;font-weight:600;color:#14141b}
.bdchip .st.todo{background:#9696ad}.bdchip .st.doing{background:#ffd24a}.bdchip .st.review{background:#9fcaff}.bdchip .st.done{background:#8fd9a8}`;
  document.head.append(css);

  const nav = document.querySelector('.edsw');
  if (!nav) return;
  const drive = document.createElement('a');
  drive.className = 'bdlink'; drive.target = '_blank'; drive.rel = 'noopener';
  drive.title = 'ノーツ（.asset）を保存する Google ドライブのフォルダを開く';
  drive.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>ドライブ';
  if (CFG.driveUrl) drive.href = CFG.driveUrl; else drive.hidden = true;
  const chip = document.createElement('a');
  chip.className = 'bdchip'; chip.href = 'index.html#board'; chip.title = '譜面ボードを開く';
  nav.after(drive, chip);

  const user = () => { try { return localStorage.getItem(USER_KEY) || ''; } catch (e) { return ''; } };
  const asset = () => (typeof S !== 'undefined' && S.name) || '';
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  let rows = [];

  function render() {
    if (!CFG.boardApiUrl) { chip.innerHTML = 'ボード未設定'; return; }
    const r = rows.find(x => x.part === PART && String(x.asset).toLowerCase() === asset().toLowerCase());
    if (!r) { chip.innerHTML = `ボード: <b>${esc(asset())}</b> は未登録`; return; }
    chip.innerHTML = `<span class="st ${esc(r.status)}">${STATUS_JP[r.status] || esc(r.status)}</span>${esc(r.song)} ${esc(r.difficulty)}` +
      (r.assignee ? `　担当 ${esc(r.assignee)}` : '') + (user() ? '' : '　（名前未設定）');
  }
  async function post(body) {
    const res = await fetch(CFG.boardApiUrl, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ key: CFG.boardKey, ...body }) });
    const j = await res.json();
    if (j.ok) rows = j.rows;
    return j;
  }
  async function beat() {
    if (!CFG.boardApiUrl) return render();
    try {
      // 名前を設定していて、画面を見ているときだけ「作成中」を知らせる
      if (user() && asset() && document.visibilityState === 'visible') await post({ action: 'heartbeat', part: PART, asset: asset(), user: user() });
      else { const j = await (await fetch(CFG.boardApiUrl)).json(); if (j.ok) rows = j.rows; }
    } catch (e) { /* オフラインなどは無視 */ }
    render();
  }
  // 閉じる・切り替えるときは「作成中」を解除
  addEventListener('pagehide', () => {
    if (!CFG.boardApiUrl || !user() || !asset()) return;
    const body = JSON.stringify({ key: CFG.boardKey, action: 'heartbeat', leaving: true, part: PART, asset: asset(), user: user() });
    try { navigator.sendBeacon(CFG.boardApiUrl, new Blob([body], { type: 'text/plain;charset=utf-8' })); } catch (e) { }
  });
  // 名前欄（アセット名）が変わったらすぐ反映
  let lastAsset = '';
  setInterval(() => { if (asset() !== lastAsset) { lastAsset = asset(); render(); beat(); } }, 1000);
  setInterval(beat, BEAT_MS);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') beat(); });
})();
