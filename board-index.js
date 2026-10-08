// index.html 用：Google ドライブへのリンクと譜面ボード（config.js の後に読み込む）
(function () {
  'use strict';
  const CFG = window.CHART_EDITOR_CONFIG || {};
  const $ = id => document.getElementById(id);

  // ====== Google ドライブ ======
  for (const id of ['driveBtn', 'driveLink']) { const a = $(id); if (CFG.driveUrl) a.href = CFG.driveUrl; else a.hidden = true; }

  // ====== 譜面ボード（Google スプレッドシート + Apps Script） ======
  const USER_KEY = 'ms2026.chartBoard.user', FILTER_KEY = 'ms2026.chartBoard.filter';
  const STATUS = [['todo', '未着手'], ['doing', '作成中'], ['review', '確認待ち'], ['done', '完成']];
  const DIFFS = ['Easy', 'Normal', 'Hard', 'Extra'];
  const LIVE_MS = 3 * 60 * 1000; // エディタは1分ごとに知らせるので、3分以内なら「編集中」
  const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const ls = {
    get(k) { try { return localStorage.getItem(k) || ''; } catch (e) { return ''; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) { } },
  };
  let rows = [], adding = false, serverNow = Date.now(), fetchedAt = Date.now();

  $('me').value = ls.get(USER_KEY);
  $('me').addEventListener('change', e => { ls.set(USER_KEY, e.target.value.trim()); render(); });
  try { const f = JSON.parse(ls.get(FILTER_KEY)); $('fPart').value = f.p; $('fStatus').value = f.s; $('fMine').checked = f.m; } catch (e) { $('fStatus').value = 'open'; }
  for (const id of ['fPart', 'fStatus', 'fMine']) $(id).addEventListener('change', () => {
    ls.set(FILTER_KEY, JSON.stringify({ p: $('fPart').value, s: $('fStatus').value, m: $('fMine').checked })); render();
  });

  const isLive = r => r.editingBy && r.editingAt && (serverNow + (Date.now() - fetchedAt)) - Date.parse(r.editingAt) < LIVE_MS;
  function msg(html) { $('bmsg').innerHTML = html; $('bmsg').hidden = !html; }

  async function api(body) {
    try {
      const res = body
        ? await fetch(CFG.boardApiUrl, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ key: CFG.boardKey, user: ls.get(USER_KEY), ...body }) })
        : await fetch(CFG.boardApiUrl);
      const j = await res.json();
      if (!j.ok) throw new Error(j.error || '失敗しました');
      rows = j.rows; serverNow = Date.parse(j.now) || Date.now(); fetchedAt = Date.now();
      msg(''); render();
    } catch (e) { msg(`ボードと通信できませんでした（${esc(e.message)}）。少し待ってから ↻ を押してください。`); }
  }
  const load = () => api();
  function update(id, fields) {
    const r = rows.find(x => x.id === id); if (r) Object.assign(r, fields);
    render(); return api({ action: 'update', id, fields });
  }

  function render() {
    const me = ls.get(USER_KEY), fp = $('fPart').value, fs = $('fStatus').value, mine = $('fMine').checked;
    const order = { doing: 0, review: 1, todo: 2, done: 3 };
    const list = rows
      .filter(r => (!fp || r.part === fp) && (!fs || (fs === 'open' ? r.status !== 'done' : r.status === fs)) && (!mine || (me && r.assignee === me)))
      .sort((a, b) => (order[a.status] ?? 9) - (order[b.status] ?? 9) || String(a.due || '9').localeCompare(String(b.due || '9'))
        || String(a.song).localeCompare(String(b.song)) || DIFFS.indexOf(a.difficulty) - DIFFS.indexOf(b.difficulty));
    const cnt = k => rows.filter(r => r.status === k).length;
    $('bsum').textContent = rows.length ? `全 ${rows.length} 件　未着手 ${cnt('todo')}・作成中 ${cnt('doing')}・確認待ち ${cnt('review')}・完成 ${cnt('done')}` : '';
    const today = new Date().toISOString().slice(0, 10);
    const opt = (arr, cur) => arr.map(([v, t]) => `<option value="${v}"${v === cur ? ' selected' : ''}>${t}</option>`).join('');
    const addRow = adding ? `<tr class="addrow">
        <td><select id="nPart"><option>TECH</option><option>POWER</option></select></td>
        <td><input type="text" id="nSong" placeholder="曲名"></td>
        <td><select id="nDiff">${DIFFS.map(d => `<option${d === 'Normal' ? ' selected' : ''}>${d}</option>`).join('')}</select></td>
        <td><input type="text" id="nAsset" placeholder="空なら自動"></td>
        <td><select class="st todo" disabled><option>未着手</option></select></td>
        <td><input type="text" id="nWho" placeholder="未定"></td>
        <td><input type="date" id="nDue"></td>
        <td class="note"><input type="text" id="nNote" placeholder="メモ"></td>
        <td colspan="2"><button class="primary" id="nOk">追加</button> <button id="nCancel">取消</button></td></tr>` : '';
    $('btable').querySelector('tbody').innerHTML = addRow + list.map(r => {
      const due = String(r.due || '').slice(0, 10);
      const editor = r.part === 'TECH' ? 'TechChartEditor.html' : 'PowerChartEditor.html';
      const when = r.updatedAt ? esc(r.updatedAt.slice(5, 16).replace('T', ' ')) + (r.updatedBy ? ' ' + esc(r.updatedBy) : '') : '';
      return `<tr data-id="${esc(r.id)}">
        <td><span class="part ${esc(r.part)}">${esc(r.part)}</span></td>
        <td><input type="text" data-k="song" value="${esc(r.song)}"></td>
        <td><select data-k="difficulty">${DIFFS.map(d => `<option${d === r.difficulty ? ' selected' : ''}>${d}</option>`).join('')}</select></td>
        <td><input type="text" data-k="asset" value="${esc(r.asset)}" placeholder="未定"></td>
        <td><select class="st ${esc(r.status)}" data-k="status">${opt(STATUS, r.status)}</select></td>
        <td><input type="text" data-k="assignee" value="${esc(r.assignee)}" placeholder="未定">${!r.assignee && me ? ' <button data-take>担当する</button>' : ''}</td>
        <td><input type="date" data-k="due" value="${esc(due)}" class="${due && due < today && r.status !== 'done' ? 'overdue' : ''}"></td>
        <td class="note"><input type="text" data-k="note" value="${esc(r.note)}"></td>
        <td>${isLive(r) ? `<span class="live">${esc(r.editingBy)} が編集中</span>` : `<span class="dim" title="最終更新">${when}</span>`}</td>
        <td><a class="open2" href="${editor}" title="${esc(r.part)} のエディタを開く（名前欄をアセット名にすると自動で作成中になります）">開く</a> <button class="x" data-del title="削除">✕</button></td></tr>`;
    }).join('');
    $('btable').hidden = !rows.length && !adding;
    if (CFG.boardApiUrl && !rows.length && !adding && !$('bmsg').textContent) msg('まだ譜面が登録されていません。「＋ 作る譜面を追加」から登録してください。');
    if (adding) $('nSong').focus();
    // カードにも「いま編集中」を出す
    for (const [part, id] of [['TECH', 'recentTech'], ['POWER', 'recentPower']]) {
      const el = $(id); el.querySelector('.live')?.remove();
      const who = rows.filter(r => r.part === part && isLive(r));
      if (who.length) el.querySelector('.open')?.insertAdjacentHTML('beforebegin', `<span class="live">${who.map(r => `${esc(r.editingBy)}（${esc(r.asset)}）`).join('、')} が編集中</span>`);
    }
  }

  const tbody = $('btable').querySelector('tbody');
  tbody.addEventListener('change', e => {
    const tr = e.target.closest('tr[data-id]'), k = e.target.dataset.k; if (!tr || !k) return;
    update(tr.dataset.id, { [k]: e.target.value.trim() });
  });
  tbody.addEventListener('click', e => {
    const tr = e.target.closest('tr[data-id]');
    if (tr && e.target.closest('[data-take]')) update(tr.dataset.id, { assignee: ls.get(USER_KEY), status: 'doing' });
    if (tr && e.target.closest('[data-del]')) {
      const r = rows.find(x => x.id === tr.dataset.id);
      if (r && confirm(`「${r.song} ${r.difficulty}（${r.part}）」をボードから削除しますか？`)) { rows = rows.filter(x => x !== r); render(); api({ action: 'remove', id: r.id }); }
    }
    if (e.target.id === 'nCancel') { adding = false; render(); }
    if (e.target.id === 'nOk') {
      const row = { part: $('nPart').value, song: $('nSong').value.trim(), difficulty: $('nDiff').value, asset: $('nAsset').value.trim(), assignee: $('nWho').value.trim(), due: $('nDue').value, note: $('nNote').value.trim() };
      if (!row.song) { $('nSong').focus(); return; }
      // アセット名を空にしたら「TechChart_曲名_Hard」の形で自動で付ける（エディタの名前欄と合わせる）
      if (!row.asset) row.asset = `${row.part === 'TECH' ? 'TechChart' : 'PowerChart'}_${row.song.replace(/[^\w-]+/g, '')}_${row.difficulty}`;
      adding = false; render(); api({ action: 'add', row });
    }
  });
  tbody.addEventListener('keydown', e => {
    if (e.key === 'Enter' && e.target.closest('.addrow')) $('nOk').click();
    else if (e.key === 'Enter' && e.target.dataset.k) e.target.blur();
  });
  $('bAdd').addEventListener('click', () => { adding = true; render(); });
  $('bReload').addEventListener('click', load);

  if (!CFG.boardApiUrl) {
    msg('譜面ボードはまだ設定されていません。Google スプレッドシートを用意して <code>config.js</code> の <code>boardApiUrl</code> を設定してください（手順: <a href="https://github.com/YamadaSeigo/chart-editor/blob/main/BOARD_SETUP.md" target="_blank" rel="noopener">BOARD_SETUP.md</a>）。');
    $('bAdd').disabled = true; $('bReload').disabled = true;
  } else {
    msg('読み込み中…'); load();
    // 30秒ごとに最新にする（入力中は待つ）
    setInterval(() => {
      if (document.visibilityState === 'visible' && !document.activeElement?.closest?.('#board input,#board select')) load();
    }, 30000);
  }
})();
