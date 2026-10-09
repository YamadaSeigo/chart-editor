// index.html 用：Google ドライブへのリンクと譜面ボード（config.js の後に読み込む）
// ボードの行は「パート × 曲 × 難易度」。POWER / TECH は難易度ごと、SHIFTSYNC（Time Shift / Sync Action）と SONG（SongData）は曲に1つ（難易度は空）。
// 表示は曲ごとのカードにまとめ、POWER / TECH × 難易度のマスと SHIFT/SYNC・SONG のマスで状態を色分けする
(function () {
  'use strict';
  const CFG = window.CHART_EDITOR_CONFIG || {};
  const $ = id => document.getElementById(id);

  // ====== Google ドライブ ======
  for (const id of ['driveBtn', 'driveLink']) { const a = $(id); if (CFG.driveUrl) a.href = CFG.driveUrl; else a.hidden = true; }
  if (CFG.audioDriveUrl) $('audioDriveBtn').href = CFG.audioDriveUrl; else $('audioDriveBtn').hidden = true;
  if (CFG.trashUrl) $('trashBtn').href = CFG.trashUrl; else $('trashBtn').hidden = true;

  // ====== 譜面ボード（Google スプレッドシート + Apps Script） ======
  const USER_KEY = 'ms2026.chartBoard.user', FILTER_KEY = 'ms2026.chartBoard.filter2', ROWS_KEY = 'ms2026.chartBoard.rows', FOLD_KEY = 'ms2026.chartBoard.fold';
  const STATUS = [['todo', '未着手'], ['doing', '作成中'], ['review', '確認待ち'], ['done', '完成']];
  const ST_JP = Object.fromEntries(STATUS);
  const DIFFS = ['Easy', 'Normal', 'Hard', 'Extra'];
  const CHART_PARTS = ['POWER', 'TECH'];          // 難易度ごとに作る
  const SONG_PARTS = ['SHIFTSYNC', 'SONG'];       // 曲に1つ
  const PART_JP = { POWER: 'POWER', TECH: 'TECH', SHIFTSYNC: 'SHIFT/SYNC', SONG: 'SONG' };
  const EDITOR = { TECH: 'TechChartEditor.html', POWER: 'PowerChartEditor.html', SHIFTSYNC: 'ShiftSyncEditor.html', SONG: 'SongEditor.html' };
  const LIVE_MS = 3 * 60 * 1000; // エディタは1分ごとに知らせるので、3分以内なら「編集中」
  const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const lc = s => String(s ?? '').toLowerCase();
  const ls = {
    get(k) { try { return localStorage.getItem(k) || ''; } catch (e) { return ''; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) { } },
  };
  let rows = [], serverNow = Date.now(), fetchedAt = Date.now();
  const isSongPart = p => SONG_PARTS.includes(p);
  const songKey = s => DriveAudio.norm(s || '');
  const today = () => new Date().toISOString().slice(0, 10);
  const me = () => ls.get(USER_KEY);

  // 名前（name-gate.js で入力。入れるまでページは使えない）
  const showMe = () => { $('meName').textContent = me() || '未設定'; };
  showMe();
  $('me').addEventListener('click', () => NameGate.ask(true));
  NameGate.onChange(() => { showMe(); render(); });

  // ====== 絞り込み ======
  const filt = { q: '', song: 'open', st: '', mine: false };
  try { Object.assign(filt, JSON.parse(ls.get(FILTER_KEY)) || {}); } catch (e) { }
  function syncFilter() {
    $('fSearch').value = filt.q;
    $('fSong').querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.v === filt.song));
    $('fStatus').querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.v === filt.st));
    $('fMine').classList.toggle('on', !!filt.mine);
    ls.set(FILTER_KEY, JSON.stringify(filt));
  }
  $('fSearch').addEventListener('input', e => { filt.q = e.target.value; ls.set(FILTER_KEY, JSON.stringify(filt)); render(); });
  $('fSong').addEventListener('click', e => { const b = e.target.closest('button'); if (b) { filt.song = b.dataset.v; syncFilter(); render(); } });
  $('fStatus').addEventListener('click', e => { const b = e.target.closest('button'); if (b) { filt.st = b.dataset.v; syncFilter(); render(); } });
  $('fMine').addEventListener('click', () => { filt.mine = !filt.mine; syncFilter(); render(); });
  syncFilter();

  // 折りたたみ（曲ごと。決めていない曲は、完成していれば閉じる）
  let fold = {};
  try { fold = JSON.parse(ls.get(FOLD_KEY)) || {}; } catch (e) { }
  const isOpen = g => fold[g.key] ?? !g.complete;
  function setOpen(key, open) { fold[key] = open; ls.set(FOLD_KEY, JSON.stringify(fold)); }

  const isLive = r => r.editingBy && r.editingAt && (serverNow + (Date.now() - fetchedAt)) - Date.parse(r.editingAt) < LIVE_MS;
  function msg(html) { $('bmsg').innerHTML = html; $('bmsg').hidden = !html; }

  async function api(body) {
    try {
      const res = body
        ? await fetch(CFG.boardApiUrl, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ key: CFG.boardKey, user: me(), ...body }) })
        : await fetch(CFG.boardApiUrl);
      const j = await res.json();
      if (!j.ok) throw new Error(j.error || '失敗しました');
      rows = j.rows; serverNow = Date.parse(j.now) || Date.now(); fetchedAt = Date.now();
      ls.set(ROWS_KEY, JSON.stringify(rows));
      msg(''); render(); refreshRowDlg();
    } catch (e) { msg(`ボードと通信できませんでした（${esc(e.message)}）。少し待ってから「↻ 更新」を押してください。`); }
  }
  const load = () => api();
  function update(id, fields) {
    const r = rows.find(x => x.id === id); if (r) Object.assign(r, fields);
    render(); refreshRowDlg(); return api({ action: 'update', id, fields });
  }
  function addRows(list) {
    if (!list.length) return;
    rows = rows.concat(list.map(r => ({ ...r, id: 'tmp' + Math.random(), status: r.status || 'todo' }))); render();
    api({ action: 'addMany', rows: list });
  }

  // アセット名：エディタの名前欄・ドライブのファイル名と同じ形
  const clean = s => String(s).replace(/[^\w-]+/g, '');
  function assetName(part, song, diff) {
    if (part === 'SHIFTSYNC') return `ShiftSync_${clean(song)}`;
    if (part === 'SONG') return `SongData_${clean(song)}`;
    return `${part === 'TECH' ? 'TechChart' : 'PowerChart'}_${clean(song)}_${diff}`;
  }
  const rowLabel = r => `${r.song} ${isSongPart(r.part) ? PART_JP[r.part] : `${r.part} ${r.difficulty}`}`;
  const editorUrl = r => EDITOR[r.part] + (r.asset ? '#open=' + encodeURIComponent(r.asset) : '');
  const driveFile = r => r.asset ? DriveCharts.find(charts, r.part, r.asset) : null;
  function driveWhat(f) {
    if (f.part === 'SHIFTSYNC') return f.shifts != null ? `TS ${f.shifts}・SA ${f.cues}` : `${f.notes} 個`;
    if (f.part === 'SONG') return f.charts != null ? `譜面 ${f.charts}/8` : `${f.notes} 個`;
    return `${f.notes} ノーツ`;
  }

  // ====== 曲ごとにまとめる ======
  function groups() {
    const map = new Map();
    for (const r of rows) {
      const key = songKey(r.song) || '(no-song)';
      if (!map.has(key)) map.set(key, { key, song: r.song || '（曲名なし）', rows: [] });
      map.get(key).rows.push(r);
    }
    for (const g of map.values()) {
      g.count = Object.fromEntries(STATUS.map(([k]) => [k, g.rows.filter(r => r.status === k).length]));
      g.complete = g.rows.length > 0 && g.count.done === g.rows.length;
      g.live = g.rows.filter(isLive);
      g.mine = g.rows.some(r => me() && r.assignee === me());
      g.due = g.rows.filter(r => r.status !== 'done' && r.due).map(r => String(r.due).slice(0, 10)).sort()[0] || '';
      g.audio = DriveAudio.find(audio, g.song);
      const want = [...CHART_PARTS.flatMap(p => DIFFS.map(d => [p, d])), ...SONG_PARTS.map(p => [p, ''])];
      g.missing = want.filter(([p, d]) => !g.rows.some(r => r.part === p && (isSongPart(p) || r.difficulty === d)));
    }
    return [...map.values()];
  }
  const cellRow = (g, part, diff) => g.rows.find(r => r.part === part && (isSongPart(part) || r.difficulty === diff));

  function pbar(count, total) {
    return `<span class="pbar">${['done', 'review', 'doing', 'todo'].map(k => count[k] ? `<i class="st-${k}" style="width:${count[k] / total * 100}%" title="${ST_JP[k]} ${count[k]}"></i>` : '').join('')}</span>`;
  }

  function tile(g, part, diff, wide) {
    const r = cellRow(g, part, diff), cls = wide ? ' wide' : '';
    if (!r) return `<button class="tile add${cls}" data-add="${esc(part)}|${esc(diff)}" data-song="${esc(g.song)}" title="${esc(PART_JP[part])}${diff ? ' ' + diff : ''} をボードに追加">＋ ${wide ? esc(PART_JP[part]) + ' を' : ''}追加</button>`;
    const f = chartsErr ? null : driveFile(r), due = String(r.due || '').slice(0, 10);
    const over = due && due < today() && r.status !== 'done', live = isLive(r), mine = me() && r.assignee === me();
    const dim = (filt.st && r.status !== filt.st) || (filt.mine && !mine);
    const cloud = chartsErr ? '' : f ? `<span class="cl${f.notes ? '' : ' zero'}">☁ ${esc(driveWhat(f))}</span>` : '<span class="cl no">☁ 未保存</span>';
    const t3 = live ? `● ${esc(r.editingBy)} が編集中` : over ? `期限切れ ${esc(due.slice(5).replace('-', '/'))}` : due ? `期限 ${esc(due.slice(5).replace('-', '/'))}` : r.note ? esc(r.note) : '';
    const tip = [`${rowLabel(r)}（${ST_JP[r.status] || r.status}）`, r.asset && `アセット名: ${r.asset}`, r.assignee && `担当: ${r.assignee}`, due && `期限: ${due}`, r.note && `メモ: ${r.note}`, f && `ドライブ: ${driveWhat(f)}・${DriveCharts.fmtDate(f.updated)} ${f.savedBy || ''}`].filter(Boolean).join('\n');
    return `<button class="tile st-${esc(r.status)}${cls}${live ? ' editing' : ''}${mine ? ' mine' : ''}${dim ? ' dim' : ''}" data-id="${esc(r.id)}" title="${esc(tip)}">
      <span class="t1">${wide ? `<span class="ptag ${esc(part)}">${esc(PART_JP[part])}</span>` : ''}${esc(ST_JP[r.status] || r.status)}${cloud}</span>
      <span class="t2${r.assignee ? '' : ' none'}">${r.assignee ? esc(r.assignee) : '担当未定'}</span>
      <span class="t3${over ? ' over' : ''}">${t3}</span></button>`;
  }

  function songCard(g) {
    const open = isOpen(g), total = g.rows.length;
    const songRow = cellRow(g, 'SONG', '');
    const mini = [...CHART_PARTS.flatMap(p => DIFFS.map(d => cellRow(g, p, d))), ...SONG_PARTS.map(p => cellRow(g, p, ''))]
      .map(r => r ? `<i class="st-${esc(r.status)}"></i>` : '<i class="none"></i>').join('');
    const head = `<div class="shead" data-fold="${esc(g.key)}">
        <span class="fold">▶</span>
        <span class="sname"><h3 title="${esc(g.song)}">${esc(g.song)}</h3>${g.audio ? '<span class="hasaudio" title="音源フォルダに同じ名前の音源があります">♪</span>' : '<span class="noaudio" title="音源フォルダに同じ名前の音源がありません">音源なし</span>'}</span>
        ${g.live.length ? `<span class="live">${esc([...new Set(g.live.map(r => r.editingBy))].join('、'))} が編集中</span>` : ''}
        ${open ? '' : `<span class="mini" title="POWER Easy〜Extra・TECH Easy〜Extra・SHIFT/SYNC・SONG">${mini}</span>`}
        <span class="sprog">${pbar(g.count, total)}<span class="cnt"><b>${g.count.done}</b>/${total} 完成${g.due && !g.complete ? `・期限 ${esc(g.due.slice(5).replace('-', '/'))}` : ''}</span></span>
        <span class="sact">
          ${g.missing.length ? `<button data-addmissing="${esc(g.song)}" title="${esc(g.missing.map(([p, d]) => PART_JP[p] + (d ? ' ' + d : '')).join('、'))}">＋ 足りない ${g.missing.length}</button>` : ''}
          <button class="ghost" data-rename="${esc(g.song)}" title="この曲の曲名を変える（ボードのすべての行）">✎</button>
          ${songRow ? `<a class="btn" style="--c:var(--song)" href="${esc(editorUrl(songRow))}" title="SONG Editor でこの曲の SongData を開く">♫ SONG Editor</a>` : ''}
        </span>
      </div>`;
    if (!open) return `<div class="song${g.complete ? ' complete' : ''}">${head}</div>`;
    const body = `<div class="sbody"><div class="mx">
        <span></span>${DIFFS.map(d => `<span class="h ${d}">${d}</span>`).join('')}
        ${CHART_PARTS.map(p => `<span class="lab"><span class="ptag ${p}">${p}</span></span>${DIFFS.map(d => tile(g, p, d)).join('')}`).join('')}
        <span class="lab dim" title="曲に1つ：SHIFT/SYNC＝Time Shift / Sync Action、SONG＝SongData（譜面と SHIFT/SYNC をまとめたもの）">曲全体</span>${tile(g, 'SHIFTSYNC', '', true)}${tile(g, 'SONG', '', true)}
      </div></div>`;
    return `<div class="song expanded${g.complete ? ' complete' : ''}">${head}${body}</div>`;
  }

  function render() {
    const all = groups();
    const q = DriveAudio.norm(filt.q.trim());
    const list = all
      .filter(g => !filt.song || (filt.song === 'done' ? g.complete : !g.complete))
      .filter(g => !filt.mine || g.mine)
      .filter(g => !q || songKey(g.song).includes(q) || g.rows.some(r => DriveAudio.norm(r.assignee).includes(q) || DriveAudio.norm(r.asset).includes(q)))
      // 編集中・期限が近い曲を上に。完成した曲は下
      .sort((a, b) => (a.complete - b.complete) || (b.live.length > 0) - (a.live.length > 0)
        || (a.due || '9').localeCompare(b.due || '9') || a.song.localeCompare(b.song));

    const total = rows.length, cnt = Object.fromEntries(STATUS.map(([k]) => [k, rows.filter(r => r.status === k).length]));
    $('bsum').innerHTML = total ? `曲 <b>${all.length}</b>（完成 <b>${all.filter(g => g.complete).length}</b>）・譜面 <b>${total}</b> 件` + (list.length !== all.length ? `　表示 ${list.length} 曲` : '') : '';
    $('bprog').hidden = !total;
    if (total) $('bprog').innerHTML = `${pbar(cnt, total)}<span class="legend">${STATUS.map(([k, t]) => `<span class="st-${k}">${t} <b>${cnt[k]}</b></span>`).join('')}</span>`;
    $('bFold').textContent = list.length && list.every(isOpen) ? 'すべて折りたたむ' : 'すべて広げる';

    $('blist').innerHTML = list.map(songCard).join('');
    if (CFG.boardApiUrl && !rows.length && !$('bmsg').textContent) msg('まだ譜面が登録されていません。「＋ 曲・譜面を追加」か、下の「音源」から登録してください。');
    else if (rows.length && !list.length) $('blist').innerHTML = '<div class="empty">この条件に合う曲はありません。上の絞り込みを変えてください。</div>';
    renderAudio();
    renderCheck();
    // エディタのカードにも「いま編集中」を出す
    for (const [part, id] of [['TECH', 'recentTech'], ['POWER', 'recentPower'], ['SHIFTSYNC', 'recentSync'], ['SONG', 'recentSong']]) {
      const el = $(id); if (!el) continue;
      el.querySelector('.live')?.remove();
      const who = rows.filter(r => r.part === part && isLive(r));
      if (who.length) el.querySelector('.open')?.insertAdjacentHTML('beforebegin', `<span class="live">${who.map(r => `${esc(r.editingBy)}（${esc(r.asset)}）`).join('、')} が編集中</span>`);
    }
  }

  // ====== ボードの操作 ======
  $('blist').addEventListener('click', e => {
    const t = e.target.closest('.tile[data-id]');
    if (t) { openRowDlg(t.dataset.id); return; }
    const add = e.target.closest('.tile[data-add]');
    if (add) {
      const [part, diff] = add.dataset.add.split('|'), song = add.dataset.song;
      addRows([{ part, song, difficulty: diff, asset: assetName(part, song, diff) }]);
      return;
    }
    const miss = e.target.closest('[data-addmissing]');
    if (miss) { openAddDlg(miss.dataset.addmissing); return; }
    const ren = e.target.closest('[data-rename]');
    if (ren) { renameSong(ren.dataset.rename); return; }
    if (e.target.closest('a,button')) return;
    const h = e.target.closest('[data-fold]');
    if (h) { const g = groups().find(x => x.key === h.dataset.fold); if (g) { setOpen(g.key, !isOpen(g)); render(); } }
  });
  $('bFold').addEventListener('click', () => {
    const list = groups(), open = !list.every(isOpen);
    list.forEach(g => { fold[g.key] = open; });
    ls.set(FOLD_KEY, JSON.stringify(fold)); render();
  });
  async function renameSong(song) {
    const to = prompt(`「${song}」の新しい曲名（音源のファイル名と同じにすると音源が自動で読み込まれます）`, song);
    if (!to || !to.trim() || to.trim() === song) return;
    const list = rows.filter(r => songKey(r.song) === songKey(song));
    list.forEach(r => { r.song = to.trim(); });
    render();
    for (const r of list) await api({ action: 'update', id: r.id, fields: { song: to.trim() } });
  }

  // ---- 1マスの詳細 ----
  let dlgId = null;
  const rowDlg = $('rowDlg');
  function openRowDlg(id) { dlgId = id; renderRowDlg(); if (!rowDlg.open) rowDlg.showModal(); }
  function refreshRowDlg() {
    if (!rowDlg.open || !dlgId) return;
    // 入力中は描き直さない
    if (rowDlg.contains(document.activeElement) && document.activeElement.matches('input')) return;
    renderRowDlg();
  }
  function renderRowDlg() {
    const r = rows.find(x => x.id === dlgId);
    if (!r) { rowDlg.close(); return; }
    const f = chartsErr ? null : driveFile(r), due = String(r.due || '').slice(0, 10), over = due && due < today() && r.status !== 'done';
    const dv = chartsErr ? '' : f
      ? `<a class="dv${f.notes ? '' : ' zero'}" href="${esc(f.url)}" target="_blank" rel="noopener" title="ドライブで開く（${esc(f.path)}${esc(f.name)}）">☁ ${esc(driveWhat(f))}・${esc(DriveCharts.fmtDate(f.updated))}${f.savedBy ? ' ' + esc(f.savedBy) : ''}</a>`
      : '<span class="dv" title="ドライブにまだありません">☁ 未保存</span>';
    const when = r.updatedAt ? `更新 ${esc(DriveCharts.fmtDate(r.updatedAt))}${r.updatedBy ? ' ' + esc(r.updatedBy) : ''}` : '';
    const color = { TECH: 'var(--tech)', POWER: 'var(--power)', SHIFTSYNC: 'var(--sync)', SONG: 'var(--song)' }[r.part] || 'var(--line)';
    rowDlg.innerHTML = `<div class="dh"><span class="ptag ${esc(r.part)}">${esc(PART_JP[r.part] || r.part)}</span>
        <h3>${esc(r.song)}${r.difficulty && !isSongPart(r.part) ? ` <span class="dim" style="font-size:14px">${esc(r.difficulty)}</span>` : ''}</h3>
        <button class="ghost icon" data-x title="閉じる">✕</button></div>
      <div class="db">
        <div class="seg" role="group" aria-label="状態">${STATUS.map(([k, t]) => `<button data-st="${k}" class="st-${k}${k === r.status ? ' on' : ''}" aria-pressed="${k === r.status}">${t}</button>`).join('')}</div>
        <div class="grid2">
          <label class="fld"><span>担当</span><span class="who"><input type="text" data-k="assignee" value="${esc(r.assignee)}" placeholder="未定">${me() && r.assignee !== me() ? '<button data-take title="自分を担当にする（未着手なら作成中にする）">自分</button>' : ''}</span></label>
          <label class="fld"><span>期限${over ? '<b style="color:#ff9aa8">期限切れ</b>' : ''}</span><input type="date" data-k="due" value="${esc(due)}" class="${over ? 'overdue' : ''}"></label>
        </div>
        <label class="fld"><span>メモ</span><input type="text" data-k="note" value="${esc(r.note)}" placeholder="—"></label>
        <label class="fld"><span>アセット名（エディタの「名前」欄・ドライブのファイル名）</span><input type="text" class="mono" data-k="asset" value="${esc(r.asset)}" placeholder="未定"></label>
        <div class="info">${dv}${isLive(r) ? `<span class="live">${esc(r.editingBy)} が編集中</span>` : `<span class="upd">${when}</span>`}</div>
      </div>
      <div class="df">
        <button class="danger" data-del title="ボードから削除（ドライブのファイルは消えません）">🗑 削除</button>
        <span class="sp"></span>
        <a class="btn open" style="--c:${color}" href="${esc(editorUrl(r))}" title="エディタで開く（ドライブにあればそれを、なければこの名前で新しく作る）">${esc(PART_JP[r.part] || r.part)} のエディタで開く ▶</a>
      </div>`;
  }
  rowDlg.addEventListener('click', e => {
    if (e.target === rowDlg || e.target.closest('[data-x]')) { rowDlg.close(); return; }
    const r = rows.find(x => x.id === dlgId); if (!r) return;
    const st = e.target.closest('[data-st]');
    if (st && r.status !== st.dataset.st) { update(r.id, { status: st.dataset.st }); return; }
    if (e.target.closest('[data-take]')) { update(r.id, { assignee: me(), ...(r.status === 'todo' ? { status: 'doing' } : {}) }); return; }
    if (e.target.closest('[data-del]') && confirm(`「${rowLabel(r)}」をボードから削除しますか？\n（ドライブに保存されたファイルは消えません）`)) {
      rows = rows.filter(x => x !== r); rowDlg.close(); render(); api({ action: 'remove', id: r.id });
    }
  });
  rowDlg.addEventListener('change', e => {
    const k = e.target.dataset.k; if (!k || !dlgId) return;
    update(dlgId, { [k]: e.target.value.trim() });
  });
  rowDlg.addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.dataset.k) e.target.blur(); });

  // ---- 曲・譜面の追加 ----
  const addDlg = $('addDlg');
  function openAddDlg(song) {
    addDlg.innerHTML = `<div class="dh"><h3>曲・譜面を追加</h3><button class="ghost icon" data-x title="閉じる">✕</button></div>
      <div class="db">
        <label class="fld"><span>曲名（音源のファイル名と同じにすると、エディタで音源が自動で読み込まれます）</span><input type="text" id="aSong" list="audioNames" value="${esc(song || '')}" placeholder="曲名を入力" spellcheck="false"></label>
        <div><div class="fld"><span>作るもの（チェックしたものを「未着手」で追加。点線はもうボードにあるもの）</span></div><div class="pick" id="aPick" style="margin-top:6px"></div></div>
        <div class="grid2">
          <label class="fld"><span>担当</span><input type="text" id="aWho" placeholder="未定"></label>
          <label class="fld"><span>期限</span><input type="date" id="aDue"></label>
        </div>
      </div>
      <div class="df"><span class="dim" id="aInfo"></span><span class="sp"></span><button data-x>取消</button><button class="primary" id="aOk">追加する</button></div>`;
    renderPick();
    addDlg.showModal();
    $('aSong').focus();
  }
  function renderPick() {
    const song = $('aSong').value.trim(), key = songKey(song);
    const has = (p, d) => key && rows.some(r => songKey(r.song) === key && r.part === p && (isSongPart(p) || r.difficulty === d));
    const prev = Object.fromEntries([...$('aPick').querySelectorAll('input')].map(x => [x.dataset.v, x.checked]));
    const box = (p, d, label, wide) => {
      const v = `${p}|${d}`, h = has(p, d);
      return `<label class="${h ? 'have' : ''}${wide ? ' wide' : ''}" title="${h ? 'もうボードにあります' : ''}"><input type="checkbox" data-v="${v}" ${h ? 'disabled' : prev[v] === false ? '' : 'checked'}>${label}</label>`;
    };
    $('aPick').innerHTML = `<span></span>${DIFFS.map(d => `<span class="dim" style="text-align:center">${d}</span>`).join('')}`
      + CHART_PARTS.map(p => `<span><span class="ptag ${p}">${p}</span></span>${DIFFS.map(d => box(p, d, d)).join('')}`).join('')
      + `<span class="dim">曲全体</span>${box('SHIFTSYNC', '', 'SHIFT/SYNC', true)}${box('SONG', '', 'SONG', true)}`;
    const n = $('aPick').querySelectorAll('input:checked:not(:disabled)').length;
    $('aInfo').textContent = song ? `${n} 件を追加` : '';
    $('aOk').disabled = !song || !n;
  }
  addDlg.addEventListener('input', e => { if (e.target.id === 'aSong') renderPick(); });
  addDlg.addEventListener('change', e => { if (e.target.closest('#aPick')) renderPick(); });
  addDlg.addEventListener('click', e => {
    if (e.target === addDlg || e.target.closest('[data-x]')) { addDlg.close(); return; }
    if (e.target.id !== 'aOk') return;
    const song = $('aSong').value.trim(); if (!song) return;
    const assignee = $('aWho').value.trim(), due = $('aDue').value;
    const list = [...$('aPick').querySelectorAll('input:checked:not(:disabled)')].map(x => {
      const [part, difficulty] = x.dataset.v.split('|');
      return { part, song, difficulty, asset: assetName(part, song, difficulty), assignee, due };
    });
    addDlg.close();
    setOpen(songKey(song), true);
    addRows(list);
  });
  addDlg.addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.id === 'aSong' && !$('aOk').disabled) $('aOk').click(); });

  // ====== ドライブに保存されたファイルと、ボードの状態のチェック ======
  let charts = [], chartsErr = '', trashing = false;
  async function loadCharts(force) {
    if (!DriveCharts.enabled()) return;
    try { charts = await DriveCharts.list(force); chartsErr = ''; }
    catch (e) { chartsErr = e.message; }
    render(); refreshRowDlg();
  }
  // アセット名「TechChart_曲名_Hard」「ShiftSync_曲名」「SongData_曲名」から曲名と難易度を推測する（ボードにないファイルを追加するとき）
  function guess(f) {
    const m = f.asset.match(/^(?:TechChart|PowerChart)_(.+)_(Easy|Normal|Hard|Extra)$/i) || f.asset.match(/^(?:ShiftSync|SongData)_(.+)$/i);
    const base = f.part === 'SONG' && f.title ? f.title : m ? m[1] : f.asset;
    const a = audio.find(x => DriveAudio.norm(DriveAudio.songOf(x.name)) === DriveAudio.norm(m ? m[1] : base));
    const part = f.part || 'TECH';
    return { part, song: a ? DriveAudio.songOf(a.name) : base, difficulty: isSongPart(part) ? '' : m && m[2] ? DIFFS.find(d => lc(d) === lc(m[2])) : 'Normal', asset: f.asset };
  }
  const onBoard = f => rows.some(r => r.part === f.part && lc(r.asset) === lc(f.asset));
  const orphans = () => chartsErr ? [] : charts.filter(f => f.part && !onBoard(f));
  async function moveToTrash(files) {
    if (trashing || !files.length) return;
    const names = files.slice(0, 15).map(f => `・${f.path}${f.name}（${driveWhat(f)}）`).join('\n') + (files.length > 15 ? `\n…ほか ${files.length - 15} 件` : '');
    if (!confirm(`次の ${files.length} 件をドライブのゴミ箱フォルダへ移しますか？\n\n${names}\n\n（消えるわけではありません。ゴミ箱フォルダから元のフォルダに戻せます）`)) return;
    trashing = true; renderCheck();
    try {
      const j = await DriveCharts.trash(files.map(f => f.id), me());
      charts = j.files; msg('');
      checkMsg = `${j.moved} 件をゴミ箱フォルダへ移しました。`;
    } catch (e) { checkMsg = `ゴミ箱へ移せませんでした（${e.message}）。Apps Script で authorize を実行して承認し、デプロイを更新したか確認してください。`; }
    trashing = false; render();
  }
  let checkMsg = '';
  function issues() {
    if (!DriveCharts.enabled() || chartsErr) return [];
    const out = [];
    for (const r of rows) {
      const f = driveFile(r), name = rowLabel(r), file = `${r.asset}${r.part === 'SONG' ? '.json' : '.asset'}`;
      if (!r.asset) out.push({ lv: 'warn', tag: '注意', text: name, sub: 'アセット名が空なので、ドライブのファイルと結び付けられません' });
      else if (!f && (r.status === 'done' || r.status === 'review')) out.push({ lv: 'warn', tag: '注意', text: name, sub: `${ST_JP[r.status]}なのに、ドライブに「${file}」がありません`, acts: [['作成中に戻す', () => update(r.id, { status: 'doing' })]] });
      else if (f && r.status === 'todo') out.push({ lv: 'info', tag: '情報', text: name, sub: `ドライブに保存済み（${driveWhat(f)}）なのに未着手です`, acts: [['作成中にする', () => update(r.id, { status: 'doing' })]] });
      else if (f && !f.notes && (r.status === 'done' || r.status === 'review')) out.push({ lv: 'warn', tag: '注意', text: name, sub: 'ドライブのファイルが空です（ノーツ・拍・譜面が1つもありません）' });
    }
    for (const f of orphans()) {
      out.push({
        lv: 'orphan', tag: 'ボード外', text: `${f.path}${f.name}`, sub: `${PART_JP[f.part] || 'パート不明'}・${driveWhat(f)}・${DriveCharts.fmtDate(f.updated)}${f.savedBy ? ' ' + f.savedBy : ''}　— ボードにないファイルです`,
        acts: [['ボードに追加', () => { const g = guess(f); addRows([{ ...g, status: 'doing', assignee: f.savedBy }]); }], ['🗑 ゴミ箱へ', () => moveToTrash([f]), 'danger']],
      });
    }
    return out;
  }
  let checkOpen = false;
  function renderCheck() {
    const el = $('bcheck'), list = issues(), orph = orphans();
    el.hidden = !DriveCharts.enabled() || (!rows.length && !charts.length && !chartsErr);
    const trashLink = CFG.trashUrl ? `<a class="btn ghost" href="${esc(CFG.trashUrl)}" target="_blank" rel="noopener" title="ゴミ箱フォルダ（Google ドライブ）を開く">🗑 ゴミ箱フォルダ</a>` : '';
    if (chartsErr) { el.innerHTML = `<div class="chead"><span class="ttl err">ノーツ保存フォルダを読めませんでした（${esc(chartsErr)}）。Apps Script で authorize を実行して承認し、デプロイを更新したか確認してください。</span></div>`; return; }
    const note = checkMsg ? `<span class="dim">${esc(checkMsg)}</span>` : '';
    if (!list.length) { el.innerHTML = `<div class="chead"><span class="ttl ok">✓ ボードとドライブのファイル（${charts.length} 件）は食い違いなし</span>${note}${trashLink}</div>`; return; }
    el.innerHTML = `<div class="chead">
        <span class="ttl ng">⚠ ボードとドライブの食い違い ${list.length} 件${orph.length ? `（ボードにないファイル ${orph.length} 件）` : ''}</span>${note}
        <button class="ghost" data-toggle>${checkOpen ? '閉じる ▲' : '詳しく見る ▼'}</button>
        ${orph.length ? `<button class="danger" data-trashall ${trashing ? 'disabled' : ''} title="ボードにないファイルをすべてゴミ箱フォルダへ移す">${trashing ? '移動中…' : `🗑 ボードにない ${orph.length} 件をゴミ箱へ`}</button>` : ''}
        ${trashLink}
      </div>
      ${checkOpen ? `<ul class="clist">${list.map((x, i) => `<li><span class="lv ${x.lv}">${esc(x.tag)}</span><span class="tx">${esc(x.text)}<small>${esc(x.sub)}</small></span>
        <span class="acts">${(x.acts || []).map(([t, , cls], k) => `<button class="${cls || ''}" data-fix="${i}" data-k="${k}" ${trashing ? 'disabled' : ''}>${esc(t)}</button>`).join('')}</span></li>`).join('')}</ul>` : ''}`;
    el.querySelector('[data-toggle]').addEventListener('click', () => { checkOpen = !checkOpen; renderCheck(); });
    el.querySelector('[data-trashall]')?.addEventListener('click', () => moveToTrash(orphans()));
    el.querySelectorAll('[data-fix]').forEach(b => b.addEventListener('click', () => { b.disabled = true; list[+b.dataset.fix].acts[+b.dataset.k][1](); }));
  }

  // ====== 音源（Google ドライブの音源フォルダ） ======
  let audio = [], audioErr = '', playing = null;
  const chosen = () => {
    const parts = [...document.querySelectorAll('.aopt[data-part]:checked')].map(x => x.dataset.part);
    const diffs = [...document.querySelectorAll('.aopt[data-diff]:checked')].map(x => x.dataset.diff);
    return { parts, diffs };
  };
  // その曲でボードにまだないもの（POWER / TECH は難易度ごと、SHIFT/SYNC・SONG は1つ）
  function missing(song) {
    const { parts, diffs } = chosen(), out = [];
    for (const part of parts) for (const difficulty of isSongPart(part) ? [''] : diffs) {
      if (!rows.some(r => r.part === part && (isSongPart(part) || r.difficulty === difficulty) && songKey(r.song) === songKey(song)))
        out.push({ part, song, difficulty, asset: assetName(part, song, difficulty) });
    }
    return out;
  }
  async function loadAudioList(force) {
    if (!DriveAudio.enabled()) return;
    if (!audio.length) $('amsg').textContent = '音源フォルダを読み込み中…';
    try { audio = await DriveAudio.list(force); audioErr = ''; }
    catch (e) { audioErr = e.message; }
    render();
  }
  function renderAudio() {
    $('audioNames').innerHTML = audio.map(f => `<option value="${esc(DriveAudio.songOf(f.name))}">`).join('');
    if (!DriveAudio.enabled()) { $('amsg').textContent = '譜面ボードを設定すると、音源フォルダの曲がここに出ます。'; return; }
    if (audioErr) {
      $('amsg').innerHTML = `音源フォルダを読めませんでした（${esc(audioErr)}）。Apps Script を新しいバージョンでデプロイし直したか確認してください（<a href="https://github.com/YamadaSeigo/chart-editor/blob/main/BOARD_SETUP.md#音源フォルダ" target="_blank" rel="noopener">手順</a>）。`;
      $('atable').hidden = true; return;
    }
    const unregistered = audio.filter(f => !rows.some(r => songKey(r.song) === songKey(DriveAudio.songOf(f.name))));
    $('asum').textContent = audio.length ? `${audio.length} 曲　ボード未登録 ${unregistered.length} 曲` : '';
    $('aAddAll').disabled = !unregistered.length || !chosen().parts.length;
    $('amsg').textContent = audio.length ? '' : '音源フォルダに音声ファイル（mp3 / wav / ogg など）がありません。';
    $('atable').hidden = !audio.length;
    $('atable').querySelector('tbody').innerHTML = audio.map(f => {
      const song = DriveAudio.songOf(f.name), mine = rows.filter(r => songKey(r.song) === songKey(song));
      const need = missing(song).length;
      const stat = mine.length
        ? `<span class="au-stat">${STATUS.map(([k, t]) => { const n = mine.filter(r => r.status === k).length; return n ? `<span class="${k}" title="${t}">${t} ${n}</span>` : ''; }).join('')}</span>`
        : '<span class="au-new">未登録</span>';
      return `<tr data-aid="${esc(f.id)}">
        <td><button class="au-play" data-play title="試聴">${playing === f.id ? '■' : '▶'}</button></td>
        <td><span class="au-song">${esc(song)}</span> <span class="au-path">${esc(f.path)}${esc(f.name)}</span></td>
        <td class="dim">${DriveAudio.fmtSize(f.size)}</td>
        <td class="dim">${esc(String(f.updated).slice(0, 10))}</td>
        <td>${stat}</td>
        <td>${need ? `<button data-addsong>${mine.length ? `足りない ${need} 件を追加` : `ボードに追加（${need} 件）`}</button>` : '<span class="dim">登録済み</span>'}</td></tr>`;
    }).join('');
  }
  const atbody = $('atable').querySelector('tbody');
  atbody.addEventListener('click', async e => {
    const tr = e.target.closest('tr[data-aid]'); if (!tr) return;
    const f = audio.find(x => x.id === tr.dataset.aid); if (!f) return;
    if (e.target.closest('[data-addsong]')) { setOpen(songKey(DriveAudio.songOf(f.name)), true); addRows(missing(DriveAudio.songOf(f.name))); }
    if (e.target.closest('[data-play]')) {
      const pl = $('aplayer'), btn = e.target.closest('[data-play]');
      if (playing === f.id) { pl.pause(); playing = null; renderAudio(); return; }
      btn.disabled = true; btn.textContent = '…';
      try {
        const file = await DriveAudio.load(f, p => { btn.textContent = Math.round(p * 100) + '%'; });
        if (pl.src) URL.revokeObjectURL(pl.src);
        pl.src = URL.createObjectURL(file); await pl.play(); playing = f.id;
      } catch (err) { alert('音源を読み込めませんでした: ' + err.message); }
      renderAudio();
    }
  });
  $('aplayer').addEventListener('ended', () => { playing = null; renderAudio(); });
  $('aAddAll').addEventListener('click', () => {
    const list = audio.filter(f => !rows.some(r => songKey(r.song) === songKey(DriveAudio.songOf(f.name))))
      .flatMap(f => missing(DriveAudio.songOf(f.name)));
    if (list.length && confirm(`未登録の曲の譜面 ${list.length} 件をボードに追加しますか？`)) addRows(list);
  });
  $('aReload').addEventListener('click', () => loadAudioList(true));
  document.querySelectorAll('.aopt').forEach(x => x.addEventListener('change', renderAudio));

  $('bAdd').addEventListener('click', () => openAddDlg(''));
  $('bReload').addEventListener('click', () => { checkMsg = ''; load(); loadCharts(true); });

  if (!CFG.boardApiUrl) {
    msg('譜面ボードはまだ設定されていません。Google スプレッドシートを用意して <code>config.js</code> の <code>boardApiUrl</code> を設定してください（手順: <a href="https://github.com/YamadaSeigo/chart-editor/blob/main/BOARD_SETUP.md" target="_blank" rel="noopener">BOARD_SETUP.md</a>）。');
    $('bAdd').disabled = true; $('bReload').disabled = true;
    $('aAddAll').disabled = true; $('aReload').disabled = true; renderAudio();
  } else {
    // 前回の内容をすぐ出してから、裏で最新にする
    let saved = null;
    try { saved = JSON.parse(ls.get(ROWS_KEY)); } catch (e) { }
    audio = DriveAudio.peek() || []; charts = DriveCharts.peek() || [];
    if (Array.isArray(saved) && saved.length) { rows = saved; render(); } else msg('読み込み中…');
    if (audio.length) renderAudio();
    load(); loadAudioList(); loadCharts();
    // ドライブのファイルは1分ごとに見直す
    setInterval(() => { if (document.visibilityState === 'visible') loadCharts(true); }, 60000);
    // 30秒ごとに最新にする（入力中は待つ）
    setInterval(() => {
      if (document.visibilityState === 'visible' && !document.activeElement?.closest?.('#board input,#board select,dialog input')) load();
    }, 30000);
  }
})();
