// index.html 用：Google ドライブへのリンクと譜面ボード（config.js の後に読み込む）
(function () {
  'use strict';
  const CFG = window.CHART_EDITOR_CONFIG || {};
  const $ = id => document.getElementById(id);

  // ====== Google ドライブ ======
  for (const id of ['driveBtn', 'driveLink']) { const a = $(id); if (CFG.driveUrl) a.href = CFG.driveUrl; else a.hidden = true; }
  if (CFG.audioDriveUrl) $('audioDriveBtn').href = CFG.audioDriveUrl; else $('audioDriveBtn').hidden = true;

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
        <td><input type="text" id="nSong" placeholder="曲名" list="audioNames"></td>
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
        <td><input type="text" data-k="song" value="${esc(r.song)}" list="audioNames">${DriveAudio.find(audio, r.song) ? '<span class="hasaudio" title="音源フォルダに同じ名前の音源があります（エディタで自動で読み込めます）">♪</span>' : ''}</td>
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
    renderAudio();
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
  // ====== 音源（Google ドライブの音源フォルダ） ======
  let audio = [], audioErr = '', playing = null;
  const assetName = (part, song, diff) => `${part === 'TECH' ? 'TechChart' : 'PowerChart'}_${String(song).replace(/[^\w-]+/g, '')}_${diff}`;
  const chosen = () => {
    const parts = [...document.querySelectorAll('.aopt[data-part]:checked')].map(x => x.dataset.part);
    const diffs = [...document.querySelectorAll('.aopt[data-diff]:checked')].map(x => x.dataset.diff);
    return { parts, diffs };
  };
  // その曲でボードにまだない「パート × 難易度」
  function missing(song) {
    const { parts, diffs } = chosen(), out = [];
    for (const part of parts) for (const difficulty of diffs) {
      if (!rows.some(r => r.part === part && r.difficulty === difficulty && DriveAudio.norm(r.song) === DriveAudio.norm(song)))
        out.push({ part, song, difficulty, asset: assetName(part, song, difficulty) });
    }
    return out;
  }
  async function loadAudioList(force) {
    if (!DriveAudio.enabled()) return;
    $('amsg').textContent = '音源フォルダを読み込み中…';
    try { audio = await DriveAudio.list(force); audioErr = ''; }
    catch (e) { audioErr = e.message; }
    renderAudio();
  }
  function renderAudio() {
    $('audioNames').innerHTML = audio.map(f => `<option value="${esc(DriveAudio.songOf(f.name))}">`).join('');
    if (!DriveAudio.enabled()) { $('amsg').textContent = '譜面ボードを設定すると、音源フォルダの曲がここに出ます。'; return; }
    if (audioErr) {
      $('amsg').innerHTML = `音源フォルダを読めませんでした（${esc(audioErr)}）。Apps Script を新しいバージョンでデプロイし直したか確認してください（<a href="https://github.com/YamadaSeigo/chart-editor/blob/main/BOARD_SETUP.md#音源フォルダ" target="_blank" rel="noopener">手順</a>）。`;
      $('atable').hidden = true; return;
    }
    const unregistered = audio.filter(f => !rows.some(r => DriveAudio.norm(r.song) === DriveAudio.norm(DriveAudio.songOf(f.name))));
    $('asum').textContent = audio.length ? `${audio.length} 曲　ボード未登録 ${unregistered.length} 曲` : '';
    $('aAddAll').disabled = !unregistered.length || !chosen().parts.length || !chosen().diffs.length;
    $('amsg').textContent = audio.length ? '' : '音源フォルダに音声ファイル（mp3 / wav / ogg など）がありません。';
    $('atable').hidden = !audio.length;
    $('atable').querySelector('tbody').innerHTML = audio.map(f => {
      const song = DriveAudio.songOf(f.name), mine = rows.filter(r => DriveAudio.norm(r.song) === DriveAudio.norm(song));
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
  function addRows(list) {
    if (!list.length) return;
    rows = rows.concat(list.map(r => ({ ...r, id: 'tmp' + Math.random(), status: 'todo' }))); render();
    api({ action: 'addMany', rows: list });
  }
  const atbody = $('atable').querySelector('tbody');
  atbody.addEventListener('click', async e => {
    const tr = e.target.closest('tr[data-aid]'); if (!tr) return;
    const f = audio.find(x => x.id === tr.dataset.aid); if (!f) return;
    if (e.target.closest('[data-addsong]')) addRows(missing(DriveAudio.songOf(f.name)));
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
    const list = audio.filter(f => !rows.some(r => DriveAudio.norm(r.song) === DriveAudio.norm(DriveAudio.songOf(f.name))))
      .flatMap(f => missing(DriveAudio.songOf(f.name)));
    if (list.length && confirm(`未登録の曲の譜面 ${list.length} 件をボードに追加しますか？`)) addRows(list);
  });
  $('aReload').addEventListener('click', () => loadAudioList(true));
  document.querySelectorAll('.aopt').forEach(x => x.addEventListener('change', renderAudio));

  $('bAdd').addEventListener('click', () => { adding = true; render(); });
  $('bReload').addEventListener('click', load);

  if (!CFG.boardApiUrl) {
    msg('譜面ボードはまだ設定されていません。Google スプレッドシートを用意して <code>config.js</code> の <code>boardApiUrl</code> を設定してください（手順: <a href="https://github.com/YamadaSeigo/chart-editor/blob/main/BOARD_SETUP.md" target="_blank" rel="noopener">BOARD_SETUP.md</a>）。');
    $('bAdd').disabled = true; $('bReload').disabled = true;
    $('aAddAll').disabled = true; $('aReload').disabled = true; renderAudio();
  } else {
    msg('読み込み中…'); load(); loadAudioList();
    // 30秒ごとに最新にする（入力中は待つ）
    setInterval(() => {
      if (document.visibilityState === 'visible' && !document.activeElement?.closest?.('#board input,#board select')) load();
    }, 30000);
  }
})();
