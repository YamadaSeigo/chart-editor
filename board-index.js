// index.html 用：Google ドライブへのリンクと譜面ボード（config.js の後に読み込む）
(function () {
  'use strict';
  const CFG = window.CHART_EDITOR_CONFIG || {};
  const $ = id => document.getElementById(id);

  // ====== Google ドライブ ======
  for (const id of ['driveBtn', 'driveLink']) { const a = $(id); if (CFG.driveUrl) a.href = CFG.driveUrl; else a.hidden = true; }
  if (CFG.audioDriveUrl) $('audioDriveBtn').href = CFG.audioDriveUrl; else $('audioDriveBtn').hidden = true;
  if (CFG.trashUrl) $('trashBtn').href = CFG.trashUrl; else $('trashBtn').hidden = true;

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
  let draft = {};
  const ROWS_KEY = 'ms2026.board.rows';
  const peekRows = () => { try { return JSON.parse(localStorage.getItem(ROWS_KEY)) || []; } catch (e) { return []; } };
  const keepRows = r => { try { localStorage.setItem(ROWS_KEY, JSON.stringify(r)); } catch (e) { } };
  let rows = [], adding = false, serverNow = Date.now(), fetchedAt = Date.now();

  // 名前（name-gate.js で入力。入れるまでページは使えない）
  const showMe = () => { $('meName').textContent = ls.get(USER_KEY) || '未設定'; };
  showMe();
  $('me').addEventListener('click', () => NameGate.ask(true));
  NameGate.onChange(() => { showMe(); render(); });

  // 絞り込み（チップ）
  const filt = { p: '', s: 'open', m: false };
  try { Object.assign(filt, JSON.parse(ls.get(FILTER_KEY)) || {}); } catch (e) { }
  function syncFilter() {
    $('fPart').querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.v === filt.p));
    $('fStatus').querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.v === filt.s));
    $('fMine').classList.toggle('on', !!filt.m);
    ls.set(FILTER_KEY, JSON.stringify(filt));
  }
  $('fPart').addEventListener('click', e => { const b = e.target.closest('button'); if (b) { filt.p = b.dataset.v; syncFilter(); render(); } });
  $('fStatus').addEventListener('click', e => { const b = e.target.closest('button'); if (b) { filt.s = b.dataset.v; syncFilter(); render(); } });
  $('fMine').addEventListener('click', () => { filt.m = !filt.m; syncFilter(); render(); });
  syncFilter();

  const isLive = r => r.editingBy && r.editingAt && (serverNow + (Date.now() - fetchedAt)) - Date.parse(r.editingAt) < LIVE_MS;
  function msg(html) { $('bmsg').innerHTML = html; $('bmsg').hidden = !html; }

  async function api(body) {
    try {
      const res = body
        ? await fetch(CFG.boardApiUrl, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ key: CFG.boardKey, user: ls.get(USER_KEY), ...body }) })
        : await fetch(CFG.boardApiUrl);
      const j = await res.json();
      if (!j.ok) throw new Error(j.error || '失敗しました');
      rows = j.rows; serverNow = Date.parse(j.now) || Date.now(); fetchedAt = Date.now(); keepRows(rows);
      msg(''); render();
    } catch (e) { msg(`ボードと通信できませんでした（${esc(e.message)}）。少し待ってから「↻ 更新」を押してください。`); }
  }
  const load = () => api();
  // ボード・音源の一覧・譜面の一覧を1回で読む（古い Apps Script なら別々に読む）
  let syncing = false;
  async function bundle(fresh) {
    if (syncing) return; syncing = true; setSync(true);
    try {
      const j = await (await fetch(CFG.boardApiUrl + (CFG.boardApiUrl.includes('?') ? '&' : '?') + 'action=bundle' + (fresh ? '&fresh=1' : ''))).json();
      if (!j.ok) throw new Error(j.error || '失敗しました');
      if (!j.audio || !j.charts) { await Promise.all([load(), loadAudioList(fresh), loadCharts(fresh)]); return; }
      rows = j.rows; serverNow = Date.parse(j.now) || Date.now(); fetchedAt = Date.now(); keepRows(rows);
      audio = j.audio; audioErr = ''; DriveAudio.remember(audio);
      charts = j.charts; chartsErr = ''; DriveCharts.remember(charts);
      msg(''); render();
      prefetchMine();
    } catch (e) { msg(`ボードと通信できませんでした（${esc(e.message)}）。少し待ってから「↻ 更新」を押してください。`); }
    finally { syncing = false; setSync(false); }
  }
  function setSync(on) { const b = $('bReload'); b.disabled = on; b.textContent = on ? '↻ 更新中…' : '↻ 更新'; }

  // 自分が担当している譜面（未着手・作成中）の音源を、ひまなときに先に読んでおく（エディタですぐ使える）
  let prefetched = false;
  async function prefetchMine() {
    if (prefetched || !DriveAudio.enabled()) return; prefetched = true;
    const me = ls.get(USER_KEY);
    const songs = [...new Set(rows.filter(r => r.assignee === me && (r.status === 'todo' || r.status === 'doing')).map(r => r.song))];
    const todo = [];
    for (const song of songs) { const f = DriveAudio.find(audio, song); if (f && !(await DriveAudio.isCached(f))) todo.push(f); }
    for (let i = 0; i < Math.min(todo.length, 4); i++) {
      if (document.visibilityState !== 'visible') await new Promise(r => document.addEventListener('visibilitychange', r, { once: true }));
      prefetchNote = `♪ 担当曲の音源を先読み中 ${i + 1}/${Math.min(todo.length, 4)}`; renderAudio();
      try { await DriveAudio.load(todo[i]); } catch (e) { /* 先読みの失敗は無視 */ }
    }
    prefetchNote = todo.length ? '♪ 担当曲の音源は先読み済み' : ''; renderAudio();
  }
  let prefetchNote = '';
  function update(id, fields) {
    const r = rows.find(x => x.id === id); if (r) Object.assign(r, fields);
    render(); return api({ action: 'update', id, fields });
  }
  const assetName = (part, song, diff) => `${part === 'TECH' ? 'TechChart' : 'PowerChart'}_${String(song).replace(/[^\w-]+/g, '')}_${diff}`;

  const diffSelect = (cur, attrs) => `<select class="diff ${esc(cur)}" ${attrs} title="難易度">${DIFFS.map(d => `<option${d === cur ? ' selected' : ''}>${d}</option>`).join('')}</select>`;
  const statusSeg = cur => `<div class="seg" role="group" aria-label="状態">${STATUS.map(([k, t]) => `<button data-st="${k}" class="${k}${k === cur ? ' on' : ''}" aria-pressed="${k === cur}">${t}</button>`).join('')}</div>`;

  function render() {
    const me = ls.get(USER_KEY);
    const order = { doing: 0, review: 1, todo: 2, done: 3 };
    const list = rows
      .filter(r => (!filt.p || r.part === filt.p) && (!filt.s || (filt.s === 'open' ? r.status !== 'done' : r.status === filt.s)) && (!filt.m || (me && r.assignee === me)))
      .sort((a, b) => (order[a.status] ?? 9) - (order[b.status] ?? 9) || String(a.due || '9').localeCompare(String(b.due || '9'))
        || String(a.song).localeCompare(String(b.song)) || DIFFS.indexOf(a.difficulty) - DIFFS.indexOf(b.difficulty));
    const cnt = k => rows.filter(r => r.status === k).length;
    $('bsum').innerHTML = rows.length ? `全 <b>${rows.length}</b> 件　未着手 <b>${cnt('todo')}</b>・作成中 <b>${cnt('doing')}</b>・確認待ち <b>${cnt('review')}</b>・完成 <b>${cnt('done')}</b>` + (list.length !== rows.length ? `　（表示 ${list.length} 件）` : '') : '';
    const today = new Date().toISOString().slice(0, 10);

    // 追加フォームの入力中の内容は、描き直しても残す
    if ($('addCard')) for (const k of ['nPart', 'nSong', 'nDiff', 'nAsset', 'nWho', 'nDue', 'nNote']) draft[k] = $(k).value;
    if (!adding) draft = {};
    const dv0 = (k, d = '') => esc(draft[k] ?? d);
    const addCard = adding ? `<div class="crow add ${dv0('nPart', 'POWER')}" id="addCard">
        <div class="c-main">
          <div class="c-title">
            <select class="part" id="nPart" title="パート">${['TECH', 'POWER'].map(p => `<option${p === (draft.nPart || 'POWER') ? ' selected' : ''}>${p}</option>`).join('')}</select>
            <input type="text" class="c-song" id="nSong" placeholder="曲名を入力" list="audioNames" value="${dv0('nSong')}">
            ${diffSelect(draft.nDiff || 'Normal', 'id="nDiff"')}
          </div>
          <div class="c-meta"><input type="text" class="c-asset" id="nAsset" placeholder="アセット名（空なら自動）" value="${dv0('nAsset')}"></div>
        </div>
        <div class="c-status"><span class="dim">追加すると「未着手」になります</span></div>
        <div class="c-fields">
          <label class="fld"><span>担当</span><input type="text" id="nWho" placeholder="未定" value="${dv0('nWho', me)}"></label>
          <label class="fld"><span>期限</span><input type="date" id="nDue" value="${dv0('nDue')}"></label>
          <label class="fld note"><span>メモ</span><input type="text" id="nNote" placeholder="メモ" value="${dv0('nNote')}"></label>
        </div>
        <div class="c-actions"><button id="nCancel">取消</button><button class="primary" id="nOk">追加する</button></div>
      </div>` : '';

    $('blist').innerHTML = addCard + list.map(r => {
      const due = String(r.due || '').slice(0, 10);
      const editor = (r.part === 'TECH' ? 'TechChartEditor.html' : 'PowerChartEditor.html') + (r.asset ? '#open=' + encodeURIComponent(r.asset) + '&song=' + encodeURIComponent(r.song) : '');
      const df = DriveCharts.find(charts, r.part, r.asset);
      const dv = chartsErr ? '' : df
        ? `<a class="dv${df.notes ? '' : ' zero'}" href="${esc(df.url)}" target="_blank" rel="noopener" title="ドライブで開く（${esc(df.path)}${esc(df.name)}）">☁ ${df.notes} ノーツ・${esc(DriveCharts.fmtDate(df.updated))}${df.savedBy ? ' ' + esc(df.savedBy) : ''}</a>`
        : '<span class="dv" title="ノーツ保存フォルダにまだありません">☁ 未保存</span>';
      const when = r.updatedAt ? `更新 ${esc(DriveCharts.fmtDate(r.updatedAt))}${r.updatedBy ? ' ' + esc(r.updatedBy) : ''}` : '';
      return `<div class="crow ${esc(r.part)} ${esc(r.status)}" data-id="${esc(r.id)}">
        <div class="c-main">
          <div class="c-title">
            <span class="part ${esc(r.part)}">${esc(r.part)}</span>
            <input type="text" class="c-song" data-k="song" value="${esc(r.song)}" list="audioNames" title="曲名（クリックで編集）">
            ${diffSelect(r.difficulty, 'data-k="difficulty"')}
            ${DriveAudio.find(audio, r.song) ? '<span class="hasaudio" title="音源フォルダに同じ名前の音源があります（エディタで自動で読み込めます）">♪</span>' : ''}
          </div>
          <div class="c-meta">
            <input type="text" class="c-asset" data-k="asset" value="${esc(r.asset)}" placeholder="アセット名（未定）" title="アセット名＝エディタの「名前」欄・ドライブのファイル名（クリックで編集）">
            ${dv}
            ${isLive(r) ? `<span class="live">${esc(r.editingBy)} が編集中</span>` : `<span class="upd">${when}</span>`}
          </div>
        </div>
        <div class="c-status">${statusSeg(r.status)}</div>
        <div class="c-fields">
          <label class="fld"><span>担当</span><span class="who"><input type="text" data-k="assignee" value="${esc(r.assignee)}" placeholder="未定">${!r.assignee && me ? '<button data-take title="自分を担当にして作成中にする">担当する</button>' : ''}</span></label>
          <label class="fld"><span>期限${due && due < today && r.status !== 'done' ? '<b style="color:#ff9aa8">期限切れ</b>' : ''}</span><input type="date" data-k="due" value="${esc(due)}" class="${due && due < today && r.status !== 'done' ? 'overdue' : ''}"></label>
          <label class="fld note"><span>メモ</span><input type="text" data-k="note" value="${esc(r.note)}" placeholder="—"></label>
        </div>
        <div class="c-actions">
          <a class="btn open" href="${editor}" title="${esc(r.part)} のエディタでこの譜面を開く（ドライブに保存されていればそれを、なければこの名前で新しく作る）">開く ▶</a>
          <button class="icon danger" data-del title="ボードから削除（ドライブの譜面は消えません）">🗑</button>
        </div>
      </div>`;
    }).join('');
    if (CFG.boardApiUrl && !rows.length && !adding && !$('bmsg').textContent) msg('まだ譜面が登録されていません。「＋ 作る譜面を追加」か、下の「音源」から登録してください。');
    else if (rows.length && !list.length && !adding) $('blist').innerHTML = '<div style="padding:18px 20px;color:var(--dim)">この条件に合う譜面はありません。上の絞り込みを変えてください。</div>';
    if (adding && !$('nSong').value && document.activeElement?.closest?.('#addCard') == null) $('nSong').focus();
    renderAudio();
    renderCheck();
    // カードにも「いま編集中」を出す
    for (const [part, id] of [['TECH', 'recentTech'], ['POWER', 'recentPower']]) {
      const el = $(id); el.querySelector('.live')?.remove();
      const who = rows.filter(r => r.part === part && isLive(r));
      if (who.length) el.querySelector('.open')?.insertAdjacentHTML('beforebegin', `<span class="live">${who.map(r => `${esc(r.editingBy)}（${esc(r.asset)}）`).join('、')} が編集中</span>`);
    }
  }

  const blist = $('blist');
  blist.addEventListener('change', e => {
    if (e.target.id === 'nPart') { $('addCard').className = 'crow add ' + e.target.value; return; }
    if (e.target.id === 'nDiff') { e.target.className = 'diff ' + e.target.value; return; }
    const card = e.target.closest('.crow[data-id]'), k = e.target.dataset.k; if (!card || !k) return;
    update(card.dataset.id, { [k]: e.target.value.trim() });
  });
  blist.addEventListener('click', e => {
    const card = e.target.closest('.crow[data-id]');
    const st = e.target.closest('[data-st]');
    if (card && st) { const r = rows.find(x => x.id === card.dataset.id); if (r && r.status !== st.dataset.st) update(r.id, { status: st.dataset.st }); return; }
    if (card && e.target.closest('[data-take]')) { e.preventDefault(); update(card.dataset.id, { assignee: ls.get(USER_KEY), status: 'doing' }); return; }
    if (card && e.target.closest('[data-del]')) {
      const r = rows.find(x => x.id === card.dataset.id);
      if (r && confirm(`「${r.song} ${r.difficulty}（${r.part}）」をボードから削除しますか？\n（ドライブに保存された譜面は消えません）`)) { rows = rows.filter(x => x !== r); render(); api({ action: 'remove', id: r.id }); }
      return;
    }
    if (e.target.id === 'nCancel') { adding = false; render(); }
    if (e.target.id === 'nOk') {
      const row = { part: $('nPart').value, song: $('nSong').value.trim(), difficulty: $('nDiff').value, asset: $('nAsset').value.trim(), assignee: $('nWho').value.trim(), due: $('nDue').value, note: $('nNote').value.trim() };
      if (!row.song) { $('nSong').focus(); return; }
      // アセット名を空にしたら「TechChart_曲名_Hard」の形で自動で付ける（エディタの名前欄と合わせる）
      if (!row.asset) row.asset = assetName(row.part, row.song, row.difficulty);
      adding = false; render(); api({ action: 'add', row });
    }
  });
  blist.addEventListener('keydown', e => {
    if (e.key === 'Enter' && e.target.closest('#addCard')) $('nOk').click();
    else if (e.key === 'Escape' && e.target.closest('#addCard')) $('nCancel').click();
    else if (e.key === 'Enter' && e.target.dataset.k) e.target.blur();
  });

  // ====== ドライブに保存された譜面と、ボードの状態のチェック ======
  let charts = [], chartsErr = '', trashing = false;
  async function loadCharts(force) {
    if (!DriveCharts.enabled()) return;
    try { charts = await DriveCharts.list(force); chartsErr = ''; }
    catch (e) { chartsErr = e.message; }
    render();
  }
  // アセット名「TechChart_曲名_Hard」から曲名と難易度を推測する（ボードにないファイルを追加するとき）
  function guess(f) {
    const m = f.asset.match(/^(?:TechChart|PowerChart)_(.+)_(Easy|Normal|Hard|Extra)$/i);
    const a = m && audio.find(x => DriveAudio.norm(DriveAudio.songOf(x.name)) === DriveAudio.norm(m[1]));
    return { part: f.part || 'TECH', song: a ? DriveAudio.songOf(a.name) : m ? m[1] : f.asset, difficulty: m ? DIFFS.find(d => d.toLowerCase() === m[2].toLowerCase()) : 'Normal', asset: f.asset };
  }
  const onBoard = f => rows.some(r => r.part === f.part && String(r.asset).toLowerCase() === f.asset.toLowerCase());
  const orphans = () => chartsErr ? [] : charts.filter(f => !onBoard(f));
  async function moveToTrash(files) {
    if (trashing || !files.length) return;
    const names = files.slice(0, 15).map(f => `・${f.path}${f.name}（${f.notes} ノーツ）`).join('\n') + (files.length > 15 ? `\n…ほか ${files.length - 15} 件` : '');
    if (!confirm(`次の ${files.length} 件の譜面をドライブのゴミ箱フォルダへ移しますか？\n\n${names}\n\n（消えるわけではありません。ゴミ箱フォルダから元のフォルダに戻せます）`)) return;
    trashing = true; renderCheck();
    try {
      const j = await DriveCharts.trash(files.map(f => f.id), ls.get(USER_KEY));
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
      const f = DriveCharts.find(charts, r.part, r.asset), name = `${r.song} ${r.difficulty}（${r.part}）`;
      if (!r.asset) out.push({ lv: 'warn', tag: '注意', text: name, sub: 'アセット名が空なので、ドライブの譜面と結び付けられません' });
      else if (!f && (r.status === 'done' || r.status === 'review')) out.push({ lv: 'warn', tag: '注意', text: name, sub: `${r.status === 'done' ? '完成' : '確認待ち'}なのに、ドライブに「${r.asset}.asset」がありません`, acts: [['作成中に戻す', () => update(r.id, { status: 'doing' })]] });
      else if (f && r.status === 'todo') out.push({ lv: 'info', tag: '情報', text: name, sub: `ドライブに保存済み（${f.notes} ノーツ）なのに未着手です`, acts: [['作成中にする', () => update(r.id, { status: 'doing' })]] });
      else if (f && !f.notes && (r.status === 'done' || r.status === 'review')) out.push({ lv: 'warn', tag: '注意', text: name, sub: 'ドライブの譜面にノーツが1つもありません' });
    }
    for (const f of orphans()) {
      out.push({
        lv: 'orphan', tag: 'ボード外', text: `${f.path}${f.name}`, sub: `${f.part || 'パート不明'}・${f.notes} ノーツ・${DriveCharts.fmtDate(f.updated)}${f.savedBy ? ' ' + f.savedBy : ''}　— ボードにない譜面です`,
        acts: [['ボードに追加', () => { const g = guess(f); api({ action: 'add', row: { ...g, status: 'doing', assignee: f.savedBy } }); }], ['🗑 ゴミ箱へ', () => moveToTrash([f]), 'danger']],
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
    if (!list.length) { el.innerHTML = `<div class="chead"><span class="ttl ok">✓ ボードとドライブの譜面（${charts.length} 件）は食い違いなし</span>${note}${trashLink}</div>`; return; }
    el.innerHTML = `<div class="chead">
        <span class="ttl ng">⚠ ボードとドライブの譜面の食い違い ${list.length} 件${orph.length ? `（ボードにない譜面 ${orph.length} 件）` : ''}</span>${note}
        <button class="ghost" data-toggle>${checkOpen ? '閉じる ▲' : '詳しく見る ▼'}</button>
        ${orph.length ? `<button class="danger" data-trashall ${trashing ? 'disabled' : ''} title="ボードにない譜面をすべてゴミ箱フォルダへ移す">${trashing ? '移動中…' : `🗑 ボードにない ${orph.length} 件をゴミ箱へ`}</button>` : ''}
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
    $('asum').title = prefetchNote;
    $('audioNames').innerHTML = audio.map(f => `<option value="${esc(DriveAudio.songOf(f.name))}">`).join('');
    if (!DriveAudio.enabled()) { $('amsg').textContent = '譜面ボードを設定すると、音源フォルダの曲がここに出ます。'; return; }
    if (audioErr) {
      $('amsg').innerHTML = `音源フォルダを読めませんでした（${esc(audioErr)}）。Apps Script を新しいバージョンでデプロイし直したか確認してください（<a href="https://github.com/YamadaSeigo/chart-editor/blob/main/BOARD_SETUP.md#音源フォルダ" target="_blank" rel="noopener">手順</a>）。`;
      $('atable').hidden = true; return;
    }
    const unregistered = audio.filter(f => !rows.some(r => DriveAudio.norm(r.song) === DriveAudio.norm(DriveAudio.songOf(f.name))));
    $('asum').textContent = (audio.length ? `${audio.length} 曲　ボード未登録 ${unregistered.length} 曲` : '') + (prefetchNote ? `　${prefetchNote}` : '');
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
  $('bReload').addEventListener('click', () => { checkMsg = ''; bundle(true); });

  if (!CFG.boardApiUrl) {
    msg('譜面ボードはまだ設定されていません。Google スプレッドシートを用意して <code>config.js</code> の <code>boardApiUrl</code> を設定してください（手順: <a href="https://github.com/YamadaSeigo/chart-editor/blob/main/BOARD_SETUP.md" target="_blank" rel="noopener">BOARD_SETUP.md</a>）。');
    $('bAdd').disabled = true; $('bReload').disabled = true;
    $('aAddAll').disabled = true; $('aReload').disabled = true; renderAudio();
  } else {
    rows = peekRows(); audio = DriveAudio.peek(); charts = DriveCharts.peek();
    if (rows.length || audio.length) render(); else msg('読み込み中…');
    bundle(false);
    // 1分ごとに最新にする（入力中・画面を見ていないときは待つ）。サーバー側でもキャッシュするので軽い
    setInterval(() => {
      if (document.visibilityState === 'visible' && !document.activeElement?.closest?.('#board input,#board select')) bundle(false);
    }, 60000);
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && Date.now() - fetchedAt > 60000) bundle(false); });
  }
})();
