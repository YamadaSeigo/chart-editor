// エディタ用：譜面ボードとの連携（config.js / drive-audio.js の後に読み込む）
// <script src="board.js" data-part="TECH"></script>
// ・ヘッダーに Google ドライブへのリンクと、今の譜面のボード上の状態を出す
// ・開いている譜面（アセット名 = 名前欄）がボードにあれば、定期的に「作成中」と知らせる
// ・音源フォルダ（Google ドライブ）から音源を選んで読み込む。ボードの曲名と同じ名前の音源は、前に読んだことがあれば自動で読み込む
// ・譜面をノーツ保存フォルダ（Google ドライブ）に保存する・開く。URL の #open=アセット名 でその譜面を開く（ボードの「開く」）
(function () {
  'use strict';
  const PART = document.currentScript.dataset.part;
  const CFG = window.CHART_EDITOR_CONFIG || {};
  const DA = window.DriveAudio, DC = window.DriveCharts;
  const USER_KEY = 'ms2026.chartBoard.user';
  const BEAT_MS = 60 * 1000;
  const STATUS_JP = { todo: '未着手', doing: '作成中', review: '確認待ち', done: '完成' };

  const css = document.createElement('style');
  css.textContent = `
.bdlink{display:inline-flex;align-items:center;gap:5px;color:var(--dim);text-decoration:none;border:1px solid var(--line);border-radius:7px;padding:2px 9px;font-size:12px;line-height:18px;white-space:nowrap;background:none;cursor:pointer}
.bdlink:hover{color:var(--text);background:#2e2e3e}
.bdchip{display:inline-flex;align-items:center;gap:6px;font-size:11px;color:var(--dim);white-space:nowrap}
.bdchip a{color:inherit;text-decoration:none;display:inline-flex;align-items:center;gap:6px;max-width:300px;overflow:hidden;text-overflow:ellipsis}
.bdchip a:hover{color:var(--text)}
.bdchip .st{border-radius:9px;padding:0 7px;font-weight:600;color:#14141b}
.bdchip .st.todo{background:#9696ad}.bdchip .st.doing{background:#ffd24a}.bdchip .st.review{background:#9fcaff}.bdchip .st.done{background:#8fd9a8}
.bdchip button{padding:0 8px;font-size:11px;line-height:18px;border-color:var(--accent);color:var(--accent)}
#daDlg{width:520px;max-width:92vw}
#daDlg input{width:100%;margin-bottom:8px}
.dalist{max-height:50vh;overflow:auto;border:1px solid var(--line);border-radius:8px}
.dalist button{display:flex;width:100%;gap:10px;align-items:center;border:0;border-radius:0;border-bottom:1px solid #22222d;background:none;text-align:left;padding:7px 10px}
.dalist button:hover{background:#262633}
.dalist .nm{flex:1;overflow:hidden;text-overflow:ellipsis}
.dalist .pt{color:#6a6a82;font-size:11px}
.dalist .sz{color:var(--dim);font-size:11px;font-variant-numeric:tabular-nums}
.dalist .ok{color:#8fd9a8;font-size:11px}
.dalist .hit{color:var(--accent);font-size:11px}
.daempty{padding:14px;color:var(--dim)}
.bdlink.save{border-color:var(--accent);color:var(--accent)}
.bdlink.save:hover{background:var(--accent);color:#14141b}
.dalist .who{color:var(--dim);font-size:11px;white-space:nowrap}
.dalist .cur{color:var(--accent);font-size:11px}`;
  document.head.append(css);

  const nav = document.querySelector('.edsw');
  if (!nav) return;
  const FOLDER_SVG = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>';
  const drive = document.createElement('a');
  drive.className = 'bdlink'; drive.target = '_blank'; drive.rel = 'noopener';
  drive.title = 'ノーツ（.asset）を保存する Google ドライブのフォルダを開く';
  drive.innerHTML = FOLDER_SVG + 'ドライブ';
  if (CFG.driveUrl) drive.href = CFG.driveUrl; else drive.hidden = true;
  const pickBtn = document.createElement('button');
  pickBtn.className = 'bdlink'; pickBtn.title = '音源フォルダ（Google ドライブ）から音源を選んで読み込む（ダウンロード不要）';
  pickBtn.textContent = '♪ ドライブの音源';
  pickBtn.hidden = !(DA && DA.enabled());
  const saveBtn = document.createElement('button');
  saveBtn.className = 'bdlink save'; saveBtn.textContent = '☁ ドライブに保存';
  saveBtn.title = 'この譜面をノーツ保存フォルダ（Google ドライブ）に「名前.asset」で保存（同じ名前があれば上書き）';
  const openBtn = document.createElement('button');
  openBtn.className = 'bdlink'; openBtn.textContent = '☁ 開く';
  openBtn.title = 'ノーツ保存フォルダ（Google ドライブ）の譜面を開く';
  saveBtn.hidden = openBtn.hidden = !(DC && DC.enabled());
  const chip = document.createElement('span');
  chip.className = 'bdchip';
  nav.after(drive, saveBtn, openBtn, pickBtn, chip);

  const user = () => { try { return localStorage.getItem(USER_KEY) || ''; } catch (e) { return ''; } };
  const asset = () => (typeof S !== 'undefined' && S.name) || '';
  const hasAudio = () => typeof buffer !== 'undefined' && !!buffer;
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  let rows = [], files = [], loadedId = null, loading = null, autoTried = new Set();

  // ====== 音源の読み込み ======
  async function useDriveAudio(f, label) {
    if (loading) return;
    loading = f.id; render();
    try {
      const file = await DA.load(f, p => { if (label) label.textContent = Math.round(p * 100) + '%'; chipProgress(p); });
      await loadAudio(file); // エディタ側の関数（波形を作って音源として使う）
      loadedId = f.id;
    } catch (e) {
      if (typeof toast === 'function') toast('ドライブの音源を読み込めませんでした: ' + e.message);
    }
    loading = null; render();
  }
  function chipProgress(p) { const b = chip.querySelector('[data-load]'); if (b) b.textContent = `♪ 読み込み中 ${Math.round(p * 100)}%`; }

  // ボードの行（なければ名前欄）に合う音源
  function matchFile(r) { return r ? DA.find(files, r.song) : null; }

  // ====== ボードの状態の表示 ======
  function render() {
    if (!CFG.boardApiUrl) { chip.innerHTML = '<a href="index.html#board">ボード未設定</a>'; return; }
    const r = rows.find(x => x.part === PART && String(x.asset).toLowerCase() === asset().toLowerCase());
    let html = !r
      ? `<a href="index.html#board" title="譜面ボードを開く">ボード: <b>${esc(asset())}</b> は未登録</a>`
      : `<a href="index.html#board" title="譜面ボードを開く"><span class="st ${esc(r.status)}">${STATUS_JP[r.status] || esc(r.status)}</span>${esc(r.song)} ${esc(r.difficulty)}` +
        (r.assignee ? `　担当 ${esc(r.assignee)}` : '') + (user() ? '' : '　（名前未設定）') + '</a>';
    const f = DA && matchFile(r);
    if (f) {
      if (loading === f.id) html += ' <button data-load disabled>♪ 読み込み中…</button>';
      else if (loadedId === f.id && hasAudio()) html += ' <span title="ドライブの音源を使用中">♪ 曲の音源</span>';
      else html += ` <button data-load title="音源フォルダの「${esc(f.name)}」を読み込む（${DA.fmtSize(f.size)}）">♪ ${esc(DA.songOf(f.name))} を読み込む</button>`;
    }
    chip.innerHTML = html;
    // 前に読んだことがある音源（ブラウザに残っている）は、音源がまだなければ自動で読み込む
    if (f && !hasAudio() && !loading && !autoTried.has(f.id)) {
      autoTried.add(f.id);
      DA.isCached(f).then(c => { if (c && !hasAudio()) useDriveAudio(f); });
    }
  }
  chip.addEventListener('click', e => {
    if (!e.target.closest('[data-load]')) return;
    const r = rows.find(x => x.part === PART && String(x.asset).toLowerCase() === asset().toLowerCase());
    const f = matchFile(r); if (f) useDriveAudio(f);
  });

  // ====== 音源を選ぶダイアログ ======
  const dlg = document.createElement('dialog');
  dlg.id = 'daDlg';
  dlg.innerHTML = `<h2>ドライブの音源</h2>
    <input type="text" placeholder="曲名で絞り込み" spellcheck="false">
    <div class="dalist"></div>
    <div style="display:flex;gap:8px;align-items:center;margin-top:12px">
      <span class="muted" style="flex:1">一度読み込んだ音源はこのブラウザに保存され、次からはすぐ開けます。</span>
      ${CFG.audioDriveUrl ? `<a class="bdlink" href="${esc(CFG.audioDriveUrl)}" target="_blank" rel="noopener">${FOLDER_SVG}フォルダを開く</a>` : ''}
      <button data-reload title="一覧を読み直す">↻</button><button data-close>閉じる</button>
    </div>`;
  document.body.append(dlg);
  const q = dlg.querySelector('input'), listEl = dlg.querySelector('.dalist');
  async function fillList() {
    const r = rows.find(x => x.part === PART && String(x.asset).toLowerCase() === asset().toLowerCase());
    const want = r ? DA.norm(r.song) : '';
    const words = DA.norm(q.value);
    const shown = files.filter(f => !words || DA.norm(f.path + f.name).includes(words));
    if (!files.length) { listEl.innerHTML = '<div class="daempty">音源フォルダに音声ファイルがありません。</div>'; return; }
    if (!shown.length) { listEl.innerHTML = '<div class="daempty">見つかりません。</div>'; return; }
    const cached = await Promise.all(shown.map(f => DA.isCached(f)));
    listEl.innerHTML = shown.map((f, i) => `<button data-id="${esc(f.id)}">
      <span class="nm">${esc(DA.songOf(f.name))} <span class="pt">${esc(f.path)}${esc(f.name)}</span></span>
      ${DA.norm(DA.songOf(f.name)) === want ? '<span class="hit">この譜面の曲</span>' : ''}
      ${cached[i] ? '<span class="ok">保存済み</span>' : ''}<span class="sz">${DA.fmtSize(f.size)}</span></button>`).join('');
  }
  async function refreshFiles(force) {
    try { files = await DA.list(force); } catch (e) { listEl.innerHTML = `<div class="daempty">音源フォルダを読めませんでした（${esc(e.message)}）</div>`; return false; }
    return true;
  }
  pickBtn.addEventListener('click', async () => {
    dlg.showModal(); q.value = ''; listEl.innerHTML = '<div class="daempty">読み込み中…</div>';
    if (await refreshFiles()) fillList();
    q.focus();
  });
  q.addEventListener('input', fillList);
  dlg.addEventListener('keydown', e => e.stopPropagation()); // エディタのショートカットを動かさない
  dlg.addEventListener('click', async e => {
    if (e.target === dlg || e.target.closest('[data-close]')) { dlg.close(); return; }
    if (e.target.closest('[data-reload]')) { listEl.innerHTML = '<div class="daempty">読み込み中…</div>'; if (await refreshFiles(true)) fillList(); return; }
    const b = e.target.closest('.dalist button[data-id]'); if (!b || loading) return;
    const f = files.find(x => x.id === b.dataset.id); if (!f) return;
    await useDriveAudio(f, b.querySelector('.sz'));
    dlg.close();
  });

  // ====== 譜面をドライブに保存する・開く ======
  let saving = false;
  async function saveToDrive(force) {
    if (saving) return;
    if (!user()) { alert('トップページの「あなたの名前」を先に入れてください（保存した人として記録します）'); return; }
    if (!/^[\w\-. ]{1,80}$/.test(asset())) { alert('名前（アセット名）は英数字・_・-・. で 80 文字までにしてください'); return; }
    saving = true; saveBtn.disabled = true; saveBtn.textContent = '☁ 保存中…';
    try {
      const j = await DC.save({ part: PART, asset: asset(), content: toAsset(), user: user(), force: !!force });
      if (j.conflict) {
        const f = j.file;
        saving = false;
        if (confirm(`ドライブの「${f.name}」は ${DC.fmtDate(f.updated)} に${f.savedBy ? ` ${f.savedBy} が` : ''}保存した版（${f.notes} ノーツ）に更新されています。\n\nあなたの譜面で上書きしますか？\n（キャンセルして「☁ 開く」で向こうの版を確かめることもできます）`)) return saveToDrive(true);
        return;
      }
      if (!j.ok) throw new Error(j.error);
      rows = j.rows || rows;
      dirty = false; updateSaveUI(); // エディタ側の「未保存」表示を消す
      toast(`ドライブに保存しました（${j.file.path}${j.file.name}・${j.file.notes} ノーツ）`);
      render();
    } catch (e) { toast('ドライブに保存できませんでした: ' + e.message); }
    finally { saving = false; saveBtn.disabled = false; saveBtn.textContent = '☁ ドライブに保存'; }
  }
  saveBtn.addEventListener('click', () => saveToDrive(false));

  async function openFromDrive(f) {
    if (dirty && !confirm('今の譜面に未保存の変更があります。破棄してドライブの譜面を開きますか？')) return false;
    try {
      const j = await DC.read(f.id);
      if (!importText(j.content, j.file.name)) return false;
      rememberHandle(null); // ローカルの保存先は外す（Ctrl+S で別のファイルを上書きしないように）
      toast(`ドライブの「${j.file.name}」を開きました（${j.file.notes} ノーツ）`);
      lastAsset = ''; // ボードの表示をすぐ更新
      return true;
    } catch (e) { toast('ドライブの譜面を開けませんでした: ' + e.message); return false; }
  }

  const cdlg = document.createElement('dialog');
  cdlg.id = 'dcDlg'; cdlg.className = 'dadlg';
  cdlg.innerHTML = `<h2>ドライブの譜面（${PART}）</h2>
    <input type="text" placeholder="名前で絞り込み" spellcheck="false" style="width:100%;margin-bottom:8px">
    <div class="dalist"></div>
    <div style="display:flex;gap:8px;align-items:center;margin-top:12px">
      <span class="muted" style="flex:1">開いた譜面は「☁ ドライブに保存」で同じファイルに上書きされます。</span>
      ${CFG.driveUrl ? `<a class="bdlink" href="${esc(CFG.driveUrl)}" target="_blank" rel="noopener">${FOLDER_SVG}フォルダを開く</a>` : ''}
      <button data-reload title="一覧を読み直す">↻</button><button data-close>閉じる</button>
    </div>`;
  cdlg.style.width = '600px'; cdlg.style.maxWidth = '94vw';
  document.body.append(cdlg);
  const cq = cdlg.querySelector('input'), clist = cdlg.querySelector('.dalist');
  let charts = [];
  function fillCharts() {
    const words = cq.value.toLowerCase();
    const shown = charts.filter(f => f.part === PART && (!words || f.name.toLowerCase().includes(words)));
    if (!shown.length) { clist.innerHTML = `<div class="daempty">${charts.length ? '見つかりません。' : 'まだ保存された譜面がありません。'}</div>`; return; }
    clist.innerHTML = shown.map(f => {
      const r = rows.find(x => x.part === PART && String(x.asset).toLowerCase() === f.asset.toLowerCase());
      return `<button data-id="${esc(f.id)}">
        <span class="nm">${esc(f.asset)} <span class="pt">${esc(f.path)}</span></span>
        ${f.asset.toLowerCase() === asset().toLowerCase() ? '<span class="cur">今の譜面</span>' : ''}
        ${r ? `<span class="who">${esc(r.song)} ${esc(r.difficulty)}・${STATUS_JP[r.status] || ''}</span>` : '<span class="who">ボード未登録</span>'}
        <span class="sz">${f.notes} ノーツ</span><span class="who">${esc(DC.fmtDate(f.updated))} ${esc(f.savedBy)}</span></button>`;
    }).join('');
  }
  async function loadCharts(force) {
    clist.innerHTML = '<div class="daempty">読み込み中…</div>';
    try { charts = await DC.list(force); fillCharts(); }
    catch (e) { clist.innerHTML = `<div class="daempty">ノーツ保存フォルダを読めませんでした（${esc(e.message)}）</div>`; }
  }
  openBtn.addEventListener('click', () => { cdlg.showModal(); cq.value = ''; loadCharts(); cq.focus(); });
  cq.addEventListener('input', fillCharts);
  cdlg.addEventListener('keydown', e => e.stopPropagation());
  cdlg.addEventListener('click', async e => {
    if (e.target === cdlg || e.target.closest('[data-close]')) { cdlg.close(); return; }
    if (e.target.closest('[data-reload]')) { loadCharts(true); return; }
    const b = e.target.closest('.dalist button[data-id]'); if (!b) return;
    const f = charts.find(x => x.id === b.dataset.id);
    if (f && await openFromDrive(f)) cdlg.close();
  });

  // ボードの「開く」から来たとき（#open=アセット名）：ドライブにあれば開き、なければその名前で新しい譜面にする
  async function openFromHash() {
    const m = location.hash.match(/^#open=(.+)$/); if (!m || !DC || !DC.enabled()) return;
    const want = decodeURIComponent(m[1]);
    history.replaceState(null, '', location.pathname + location.search);
    if (want.toLowerCase() === asset().toLowerCase()) return; // もう開いている
    try {
      const f = DC.find(await DC.list(true), PART, want);
      if (f) { await openFromDrive(f); return; }
    } catch (e) { toast('ドライブの譜面一覧を読めませんでした: ' + e.message); return; }
    if (confirm(`「${want}」はまだドライブに保存されていません。この名前で新しい譜面を作りますか？\n（今の譜面は${dirty ? '未保存の変更ごと' : ''}閉じます）`)) {
      loadChartObj({ name: want, notes: [] }); rememberHandle(null); seek(0);
      lastAsset = '';
      toast(`新しい譜面「${want}」を作りました。できたら「☁ ドライブに保存」で保存してください`);
    }
  }
  addEventListener('hashchange', openFromHash);

  // ====== ボードとのやり取り ======
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
  // 名前欄（アセット名）が変わったらすぐ反映。音源を外したら表示を戻す
  var lastAsset = '', lastHas = false;
  setInterval(() => {
    if (asset() !== lastAsset) { lastAsset = asset(); render(); beat(); }
    else if (hasAudio() !== lastHas) { if (!hasAudio()) loadedId = null; render(); }
    lastHas = hasAudio();
  }, 1000);
  setInterval(beat, BEAT_MS);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') beat(); });
  if (DA && DA.enabled()) refreshFiles().then(render);
  setTimeout(openFromHash, 300); // エディタの起動（自動保存の読み込み）が終わってから
})();
