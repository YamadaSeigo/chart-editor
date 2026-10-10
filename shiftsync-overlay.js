// TECH / POWER エディタ用：Time Shift / Sync Action（ドライブの SHIFTSYNC）をタイムラインに重ねて表示する（board.js の後に読み込む）
// ・ヘッダーの「⇄ SHIFT/SYNC」から、ドライブの ShiftSyncChart を選ぶ。選んでいなければ、ボードで同じ曲の SHIFT/SYNC を自動で使う
// ・エディタの drawTimeline() から ShiftSyncOverlay.draw(c) を呼ぶ（エディタの tX / RULER / tlW / tlH / S を使う）
// ・Time Shift は準備時間（案内が出てノーツが出ない時間）、Sync Action は制限時間の帯で表示し、その中にあるノーツの数も知らせる
//   （ゲームはこの時間帯のノーツを出さない：TimeShiftDirector.skipNotesInPrepare / SyncAction.skipNotesDuringCue）
window.ShiftSyncOverlay = (function () {
  'use strict';
  const DC = window.DriveCharts, DA = window.DriveAudio;
  const ROWS_KEY = 'ms2026.chartBoard.rows', CHOICE_KEY = 'ms2026.ssOverlay.choice', SS_EDITOR_KEY = 'ms2026.shiftSyncEditor.v1';
  const SHIFT_COL = '#5ad1ff', SYNC_COL = '#b98bff';
  const PART = (document.querySelector('script[src="board.js"]') || {}).dataset?.part || '';
  const lc = s => String(s ?? '').toLowerCase();
  const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  if (!DC || !DC.enabled()) return { draw() { } };

  // ゲーム側の既定値（SHIFT / SYNC Editor の「プレビューの設定」を変えていればそれを使う）
  function settings() {
    const o = { prepare: 4, shifted: 1, breakAfter: 0.5, defLimit: 10 };
    try { const u = (JSON.parse(localStorage.getItem(SS_EDITOR_KEY)) || {}).ui || {}; for (const k in o) if (u[k] >= 0) o[k] = +u[k]; } catch (e) { }
    return o;
  }

  let data = null;        // { asset, shifts: [拍], cues: [{ beat, limit }] }
  let loadingAsset = '', warnText = '';
  const getChoice = () => { try { return JSON.parse(localStorage.getItem(CHOICE_KEY)) || {}; } catch (e) { return {}; } };
  const setChoice = (asset, ss) => { const c = getChoice(); c[lc(asset)] = ss; try { localStorage.setItem(CHOICE_KEY, JSON.stringify(c)); } catch (e) { } };
  const rows = () => { try { return JSON.parse(localStorage.getItem(ROWS_KEY)) || []; } catch (e) { return []; } };
  const asset = () => (typeof S !== 'undefined' && S.name) || '';

  /** 今の譜面に使う SHIFTSYNC のアセット名（'' = 表示しない）と、それが自動かどうか */
  function wanted() {
    const c = getChoice(), k = lc(asset());
    if (k in c) return { name: c[k], auto: false };
    const all = rows(), me = all.find(r => r.part === PART && lc(r.asset) === k);
    if (!me) return { name: '', auto: true };
    const norm = DA ? DA.norm : lc;
    const ss = all.find(r => r.part === 'SHIFTSYNC' && norm(r.song) === norm(me.song) && r.asset);
    return { name: ss ? ss.asset : '', auto: true, song: me.song };
  }

  // ShiftSyncChart の .asset（または SHIFT / SYNC Editor の JSON）を読む
  function parse(text) {
    const t = text.trim();
    if (t.startsWith('{')) {
      const o = JSON.parse(t);
      return { shifts: (o.timeShiftBeats || []).map(Number), cues: (o.syncCues || []).map(c => ({ beat: +c.beat, limit: +c.limitSeconds || 0 })) };
    }
    const o = { shifts: [], cues: [] };
    let sec = null, cur = null, m;
    for (const line of text.split(/\r?\n/)) {
      if ((m = line.match(/^  (\w+):/))) { sec = m[1]; cur = null; }
      else if (sec === 'timeShiftBeats' && (m = line.match(/^\s*-\s*([-\d.eE+]+)\s*$/))) o.shifts.push(+m[1]);
      else if (sec === 'syncCues' && (m = line.match(/^\s*-\s*beat:\s*([-\d.eE+]+)/))) { cur = { beat: +m[1], limit: 0 }; o.cues.push(cur); }
      else if (sec === 'syncCues' && cur && (m = line.match(/^\s+limitSeconds:\s*([-\d.eE+]+)/))) cur.limit = +m[1];
    }
    return o;
  }

  async function sync(force) {
    const w = wanted();
    if (!w.name) { data = null; render(); return; }
    if (!force && data && lc(data.asset) === lc(w.name)) return;
    if (loadingAsset === w.name) return;
    loadingAsset = w.name; render();
    try {
      const find = list => (list || []).find(f => f.part === 'SHIFTSYNC' && lc(f.asset) === lc(w.name));
      const f = find(DC.peek()) || find(await DC.list(force));
      if (!f) { data = { asset: w.name, missing: true, shifts: [], cues: [] }; }
      else { const j = await DC.read(f.id); data = { asset: f.asset, updated: f.updated, ...parse(j.content) }; }
    } catch (e) { data = { asset: w.name, error: e.message, shifts: [], cues: [] }; }
    loadingAsset = ''; render();
  }

  // ====== ヘッダーのボタン ======
  const btn = document.createElement('button');
  btn.className = 'bdlink ssbtn';
  const css = document.createElement('style');
  css.textContent = `.bdlink.ssbtn{border-color:#3d3560;color:#c9b3ff}.bdlink.ssbtn.on{background:#2a2440}.bdlink.ssbtn .w{color:#ffd97a;margin-left:2px}
#ssDlg{width:520px;max-width:92vw}#ssDlg input{width:100%;margin-bottom:8px}#ssDlg .dalist button.sel{background:#2a2440}`;
  document.head.append(css);
  (document.querySelector('.bdlink.done') || document.querySelector('.edsw')).after(btn);
  function render() {
    const w = wanted();
    btn.classList.toggle('on', !!(data && !data.missing && !data.error));
    if (loadingAsset) btn.innerHTML = '⇄ SHIFT/SYNC 読み込み中…';
    else if (!w.name) btn.innerHTML = '⇄ SHIFT/SYNC';
    else if (data && data.missing) btn.innerHTML = `⇄ ${esc(w.name)} <span class="w">（ドライブにない）</span>`;
    else if (data && data.error) btn.innerHTML = `⇄ ${esc(w.name)} <span class="w">（読めない）</span>`;
    else btn.innerHTML = `⇄ ${esc(data ? data.asset : w.name)}${warnText ? ` <span class="w">⚠${warnCount}</span>` : ''}`;
    btn.title = (w.name ? `タイムラインに ${w.name} の Time Shift / Sync Action を表示中${w.auto ? '（ボードで同じ曲の SHIFT/SYNC を自動で選択）' : ''}` : 'Time Shift / Sync Action をタイムラインに表示する（ドライブの SHIFT/SYNC を選ぶ）')
      + (warnText ? '\n\n' + warnText : '') + '\n\nクリックで選び直す';
  }

  // ====== 選ぶダイアログ ======
  const dlg = document.createElement('dialog');
  dlg.id = 'ssDlg';
  dlg.innerHTML = `<h2>タイムラインに表示する SHIFT/SYNC</h2>
    <input type="text" placeholder="名前で絞り込み" spellcheck="false">
    <div class="dalist"></div>
    <div style="display:flex;gap:8px;align-items:center;margin-top:12px">
      <span style="flex:1;color:var(--dim);font-size:12px">帯の中（準備時間・制限時間）のノーツはゲームでは出ません。</span>
      <button data-auto title="ボードで同じ曲の SHIFT/SYNC を自動で使う">自動</button><button data-close>閉じる</button>
    </div>`;
  document.body.append(dlg);
  const listEl = dlg.querySelector('.dalist'), filterEl = dlg.querySelector('input');
  let files = [];
  async function openDlg() {
    filterEl.value = ''; dlg.showModal(); filterEl.focus();
    files = (DC.peek() || []).filter(f => f.part === 'SHIFTSYNC'); fill();
    try { files = (await DC.list(true)).filter(f => f.part === 'SHIFTSYNC'); fill(); } catch (e) { listEl.innerHTML = `<div class="daempty">ドライブを読めませんでした（${esc(e.message)}）</div>`; }
  }
  function fill() {
    const q = lc(filterEl.value.trim()), w = wanted(), song = w.song ? (DA ? DA.norm(w.song) : lc(w.song)) : '';
    const shown = files.filter(f => !q || lc(f.asset).includes(q))
      .sort((a, b) => (song && DA ? (DA.norm(b.asset).includes(song) - DA.norm(a.asset).includes(song)) : 0) || a.asset.localeCompare(b.asset));
    listEl.innerHTML = `<button data-name="" class="${!w.name ? 'sel' : ''}"><span class="nm">表示しない</span></button>`
      + shown.map(f => `<button data-name="${esc(f.asset)}" class="${lc(f.asset) === lc(w.name) ? 'sel' : ''}"><span class="nm">${esc(f.asset)}</span>
        <span class="sz">TS ${f.shifts ?? '?'}・SA ${f.cues ?? '?'}</span><span class="who">${esc(DC.fmtDate(f.updated))} ${esc(f.savedBy || '')}</span></button>`).join('')
      + (shown.length ? '' : '<div class="daempty">ドライブに SHIFT/SYNC がありません（SHIFT / SYNC Editor で保存してください）</div>');
  }
  filterEl.addEventListener('input', fill);
  dlg.addEventListener('keydown', e => e.stopPropagation()); // エディタのショートカットを動かさない
  dlg.addEventListener('click', e => {
    if (e.target === dlg || e.target.closest('[data-close]')) { dlg.close(); return; }
    if (e.target.closest('[data-auto]')) { const c = getChoice(); delete c[lc(asset())]; try { localStorage.setItem(CHOICE_KEY, JSON.stringify(c)); } catch (x) { } dlg.close(); sync(true); return; }
    const b = e.target.closest('button[data-name]'); if (!b) return;
    setChoice(asset(), b.dataset.name); dlg.close(); sync(true);
  });
  btn.addEventListener('click', openDlg);

  // ====== タイムラインに描く ======
  // 秒で表す：Time Shift の準備時間 [at - prepare, at + 休み]、Sync Action [at, at + 制限時間]（ゲームの SyncShift と同じ、拍 × 60 / BPM）
  function windows() {
    if (!data || typeof S === 'undefined' || !(S.bpm > 0)) return [];
    const spb = 60 / S.bpm, st = settings(), out = [];
    for (const b of data.shifts) { const at = b * spb; out.push({ kind: 'shift', beat: b, at, from: at - st.prepare, to: at + Math.max(st.shifted, st.breakAfter), skipTo: at + st.breakAfter }); }
    for (const c of data.cues) { const at = c.beat * spb, lim = c.limit > 0 ? c.limit : st.defLimit; out.push({ kind: 'cue', beat: c.beat, at, from: at, to: at + lim, skipTo: at + lim, limit: lim }); }
    return out;
  }
  const noteTime = n => n.t != null ? n.t : n.b != null ? n.b * 60 / S.bpm : null;
  let warnCount = 0, lastWarnAt = 0;
  function checkNotes(ws) {
    // ゲームで出ないノーツ（帯の中）を数える。重いので 0.5 秒ごと
    if (Date.now() - lastWarnAt < 500) return;
    lastWarnAt = Date.now();
    const notes = (typeof S !== 'undefined' && S.notes) || [];
    const hit = ws.map(w => ({ w, n: notes.filter(n => { const t = noteTime(n); return t != null && t > w.from && t < w.skipTo; }).length })).filter(x => x.n);
    const count = hit.reduce((a, x) => a + x.n, 0);
    const text = count ? `ゲームでは出ないノーツが ${count} 個あります：\n` + hit.map(x => `・${x.w.kind === 'shift' ? 'Time Shift の準備時間' : 'Sync Action 中'}（${x.w.beat} 拍）に ${x.n} 個`).join('\n') : '';
    if (count !== warnCount || text !== warnText) { warnCount = count; warnText = text; render(); }
  }
  function draw(c) {
    const ws = windows();
    if (!ws.length) { if (warnCount) { warnCount = 0; warnText = ''; render(); } return; }
    checkNotes(ws);
    const w = tlW, h = tlH, top = RULER, x0 = typeof LANE_LABEL_W !== 'undefined' ? LANE_LABEL_W : 0;
    c.save();
    c.beginPath(); c.rect(x0, 0, w - x0, h); c.clip();
    c.font = '600 10.5px "Segoe UI","Yu Gothic UI",sans-serif'; c.textBaseline = 'middle'; c.textAlign = 'left';
    for (const v of ws) {
      const xa = tX(v.from), xb = tX(v.to);
      if (xb < x0 || xa > w) continue;
      if (v.kind === 'shift') {
        const x = tX(v.at), g = c.createLinearGradient(xa, 0, x, 0);
        g.addColorStop(0, 'rgba(90,209,255,.04)'); g.addColorStop(1, 'rgba(90,209,255,.22)');
        c.fillStyle = g; c.fillRect(xa, top, x - xa, h - top);
        c.fillStyle = 'rgba(90,209,255,.10)'; c.fillRect(x, top, xb - x, h - top);
        c.strokeStyle = SHIFT_COL; c.lineWidth = 2; c.setLineDash([]);
        c.beginPath(); c.moveTo(x + .5, 0); c.lineTo(x + .5, h); c.stroke();
        // カウントダウンの目盛り
        c.fillStyle = 'rgba(90,209,255,.8)';
        for (let k = 1; k <= Math.floor(v.at - v.from); k++) c.fillRect(tX(v.at - k), h - 6, 1, 6);
        pill(c, x + 4, top + 9, '⇄ TIME SHIFT', SHIFT_COL);
      } else {
        c.fillStyle = 'rgba(185,139,255,.13)'; c.fillRect(xa, top, xb - xa, h - top);
        c.strokeStyle = SYNC_COL; c.lineWidth = 1.5; c.setLineDash([5, 4]);
        c.beginPath(); c.moveTo(xa + .5, top); c.lineTo(xa + .5, h); c.moveTo(xb - .5, top); c.lineTo(xb - .5, h); c.stroke();
        c.setLineDash([]);
        pill(c, Math.max(xa, x0) + 4, top + 9, `✋ SYNC ACTION ${Math.round(v.limit * 10) / 10}秒`, SYNC_COL);
      }
    }
    // 今ゲームで出ている案内（再生位置）
    const t = S.time, now = ws.find(v => t >= v.from && t < v.to);
    if (now) {
      const label = now.kind === 'shift' ? (t < now.at ? `TIME CHANGE ${Math.ceil(now.at - t)}` : 'TIME SHIFT!') : `SYNC ACTION 残り ${(now.to - t).toFixed(1)}秒`;
      c.font = '700 12px "Segoe UI","Yu Gothic UI",sans-serif';
      const tw = c.measureText(label).width + 16;
      pill(c, w - tw - 8, top + 12, label, now.kind === 'shift' ? SHIFT_COL : SYNC_COL, true);
    }
    c.restore();
  }
  function pill(c, x, y, text, col, strong) {
    const tw = c.measureText(text).width + 12, hh = strong ? 20 : 16;
    c.fillStyle = strong ? col : 'rgba(20,20,27,.85)';
    c.beginPath(); c.roundRect(x, y - hh / 2, tw, hh, hh / 2); c.fill();
    if (!strong) { c.strokeStyle = col; c.lineWidth = 1; c.stroke(); }
    c.fillStyle = strong ? '#14141b' : col; c.fillText(text, x + 6, y + .5);
  }

  // 譜面（名前欄）が変わったら選び直す。ボードやドライブが更新されたときのために、ときどき読み直す
  let lastAsset = null;
  setInterval(() => { if (asset() !== lastAsset) { lastAsset = asset(); sync(false); } }, 1000);
  setInterval(() => { if (document.visibilityState === 'visible' && wanted().name) sync(true); }, 60000);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') sync(true); });
  render();
  return { draw, refresh: () => sync(true) };
})();
