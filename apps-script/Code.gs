/**
 * MS2026 譜面ボード（Google スプレッドシートに貼り付ける Apps Script）
 *
 * 「作るべき譜面のリスト」と「誰がどの譜面を作成中か」を charts シートに保存し、
 * chart-editor のページ（index.html / 各エディタ）から読み書きする。
 * 音源フォルダ（AUDIO_FOLDER_ID）の中の音声ファイルの一覧と中身も返す（ページから音源を直接読み込むため）。
 * ノーツ保存フォルダ（NOTES_FOLDER_ID）に、エディタで作った譜面（.asset）を保存・一覧・読み込みする。
 * いらなくなった譜面はゴミ箱フォルダ（TRASH_FOLDER_ID）へ移す（Google ドライブのゴミ箱ではなく、普通のフォルダ。消えないので戻せる）。
 * 設定方法は BOARD_SETUP.md を参照。
 */
// 音源を入れる Google ドライブのフォルダ（URL の folders/ の後ろ）。このフォルダ（とその中のフォルダ）以外のファイルは返さない
const AUDIO_FOLDER_ID = '12SSJ2qgAaitkxpuXNrYUMcT1_6AIrxLT';
const AUDIO_EXT = /\.(mp3|wav|ogg|m4a|aac|flac|opus|webm)$/i;
const AUDIO_CHUNK = 10 * 1024 * 1024; // 1回で返す大きさ（base64 にすると約 13MB）。大きいほど呼び出しが減る
// ノーツ（.asset）を保存する Google ドライブのフォルダ。中に TECH / POWER のフォルダを作って分けて保存する
const NOTES_FOLDER_ID = '10ugDZ9dDHFa9-Q3CwKn8Z6v_aOJqW1xI';
const PARTS = ['TECH', 'POWER'];
// いらなくなった譜面を移すフォルダ
const TRASH_FOLDER_ID = '1zECm_gPsxV2vmoACMdmRhDINRZzx89m2';
const SHEET_NAME = 'charts';
const HEAD = ['id', 'part', 'song', 'difficulty', 'asset', 'status', 'assignee', 'due', 'note',
  'updatedAt', 'updatedBy', 'editingBy', 'editingAt'];
const EDITABLE = ['part', 'song', 'difficulty', 'asset', 'status', 'assignee', 'due', 'note'];

/**
 * 権限の承認用。Apps Script のエディタでこの関数を選んで「実行」すると、
 * スプレッドシートとドライブ（音源フォルダ）を読む権限の承認画面が出る。
 * デプロイを更新するだけでは新しい権限の承認は出ないので、権限が増えたときは一度これを実行する
 */
function authorize() {
  const folder = DriveApp.getFolderById(AUDIO_FOLDER_ID);
  const notes = DriveApp.getFolderById(NOTES_FOLDER_ID);
  DriveApp.getFolderById(TRASH_FOLDER_ID);
  PARTS.forEach(partFolder_); // 保存先のフォルダを作る（書き込みの権限もここで承認される）
  sheet_();
  Logger.log('OK: 音源フォルダ「' + folder.getName() + '」の音声ファイル ' + listAudio_().length + ' 件 / ' +
    'ノーツ保存フォルダ「' + notes.getName() + '」の譜面 ' + listCharts_().length + ' 件');
}

function doGet(e) {
  const p = (e && e.parameter) || {};
  const fresh = p.fresh === '1';
  try {
    const now = new Date().toISOString();
    // ボード・音源の一覧・譜面の一覧を1回でまとめて返す（呼び出しの回数を減らす）
    if (p.action === 'bundle') return json_({ ok: true, rows: rowsCached_(fresh), audio: audioCached_(fresh), charts: chartsCached_(fresh), now });
    if (p.action === 'audioList') return json_({ ok: true, files: audioCached_(fresh), now });
    if (p.action === 'audio') return json_(audioChunk_(p.id, Number(p.offset) || 0));
    if (p.action === 'charts') return json_({ ok: true, files: chartsCached_(fresh), now });
    if (p.action === 'chart') return json_(readChart_(p.id));
    if (p.action === 'chartByAsset') return json_(readChartByAsset_(p.part, p.asset));
    return json_({ ok: true, rows: rowsCached_(fresh), now });
  } catch (err) {
    return json_({ ok: false, error: String(err) });
  }
}

// ---------------- キャッシュ（ドライブやシートを毎回読まない） ----------------
// 一覧は CacheService に置き、保存・ゴミ箱・ボードの変更で消す。音源の一覧は 10 分（↻ で読み直し）
const CACHE = () => CacheService.getScriptCache();
function cget_(key) { try { const v = CACHE().get(key); return v ? JSON.parse(v) : null; } catch (e) { return null; } }
function cput_(key, obj, sec) { try { CACHE().put(key, JSON.stringify(obj), sec); } catch (e) { /* 大きすぎるときはキャッシュしない */ } }
function cdel_(keys) { try { CACHE().removeAll(keys); } catch (e) { } }

function rowsCached_(fresh) {
  let rows = fresh ? null : cget_('rows');
  if (!rows) { rows = readRows_(sheet_()).map(r => { const c = Object.assign({}, r); delete c._row; return c; }); cput_('rows', rows, 60); }
  return withLive_(rows);
}
function audioCached_(fresh) {
  let list = fresh ? null : cget_('audio');
  if (!list) { list = listAudio_(); cput_('audio', list, 600); }
  return list;
}
function chartsCached_(fresh) {
  let list = fresh ? null : cget_('charts');
  if (!list) { list = listCharts_(); cput_('charts', list, 600); }
  return list;
}

// 「編集中」はシートに書かずキャッシュに置く（エディタが1分ごとに知らせるたびにシートを書き換えると遅くなるため）
const liveKey_ = (part, asset) => 'live_' + part + '_' + String(asset).toLowerCase();
function withLive_(rows) {
  const keys = rows.map(r => liveKey_(r.part, r.asset));
  let live = {};
  try { live = CACHE().getAll(keys) || {}; } catch (e) { }
  return rows.map(r => {
    const v = live[liveKey_(r.part, r.asset)];
    if (!v) return Object.assign({}, r, { editingBy: '', editingAt: '' });
    const o = JSON.parse(v);
    return Object.assign({}, r, { editingBy: o.user, editingAt: o.at });
  });
}

/** 音源フォルダの音声ファイル一覧（中のフォルダも含む。path はフォルダ名/） */
function listAudio_() {
  const out = [];
  const walk = (folder, path, depth) => {
    const files = folder.getFiles();
    while (files.hasNext()) {
      const f = files.next();
      if (!AUDIO_EXT.test(f.getName()) && !/^audio\//.test(f.getMimeType())) continue;
      out.push({ id: f.getId(), name: f.getName(), path: path, size: f.getSize(), mime: f.getMimeType(), updated: f.getLastUpdated().toISOString() });
    }
    if (depth >= 3) return;
    const subs = folder.getFolders();
    while (subs.hasNext()) { const sub = subs.next(); walk(sub, path + sub.getName() + '/', depth + 1); }
  };
  walk(DriveApp.getFolderById(AUDIO_FOLDER_ID), '', 0);
  return out.sort((a, b) => (a.path + a.name).localeCompare(b.path + b.name));
}

// ---------------- ノーツ（譜面ファイル） ----------------

function partFolder_(part) {
  const root = DriveApp.getFolderById(NOTES_FOLDER_ID);
  const it = root.getFoldersByName(part);
  return it.hasNext() ? it.next() : root.createFolder(part);
}

/** 中身からパートとノーツ数を調べる */
function chartInfo_(text) {
  const part = /App\.PowerChart/.test(text) ? 'POWER' : /App\.NotesRecord/.test(text) ? 'TECH' : '';
  const notes = (text.match(part === 'POWER' ? /^\s*-\s*beat:/gm : /^\s*-\s*spawnTime:/gm) || []).length;
  return { part, notes };
}

function fileInfo_(f, path) {
  // ノーツ数は中身を読まないと分からないので、更新日時ごとにキャッシュする
  const cache = CacheService.getScriptCache(), key = 'ci_' + f.getId() + '_' + f.getLastUpdated().getTime();
  let info = null;
  try { info = JSON.parse(cache.get(key)); } catch (e) { }
  if (!info) { info = chartInfo_(f.getBlob().getDataAsString()); cache.put(key, JSON.stringify(info), 21600); }
  return {
    id: f.getId(), name: f.getName(), asset: f.getName().replace(/\.[^.]+$/, ''), path: path,
    part: info.part || (PARTS.indexOf(path.split('/')[0]) >= 0 ? path.split('/')[0] : ''), notes: info.notes,
    size: f.getSize(), updated: f.getLastUpdated().toISOString(), savedBy: f.getDescription() || '', url: f.getUrl(),
  };
}

/** ノーツ保存フォルダの譜面ファイル（.asset / .json）の一覧（中のフォルダも2段まで） */
function listCharts_() {
  const out = [];
  const walk = (folder, path, depth) => {
    const files = folder.getFiles();
    while (files.hasNext()) {
      const f = files.next();
      if (/\.(asset|json)$/i.test(f.getName())) out.push(fileInfo_(f, path));
    }
    if (depth >= 2) return;
    const subs = folder.getFolders();
    while (subs.hasNext()) { const sub = subs.next(); if (sub.getId() !== TRASH_FOLDER_ID) walk(sub, path + sub.getName() + '/', depth + 1); }
  };
  walk(DriveApp.getFolderById(NOTES_FOLDER_ID), '', 0);
  return out.sort((a, b) => (a.path + a.name).localeCompare(b.path + b.name));
}

function readChart_(id) {
  const f = DriveApp.getFileById(String(id));
  if (!inFolder_(f, NOTES_FOLDER_ID)) return { ok: false, error: 'ノーツ保存フォルダの外のファイルです' };
  const parents = f.getParents(), path = parents.hasNext() ? parents.next().getName() + '/' : '';
  return { ok: true, file: fileInfo_(f, path), content: f.getBlob().getDataAsString() };
}

function readChartByAsset_(part, asset) {
  if (PARTS.indexOf(String(part)) < 0) return { ok: false, error: 'パートが不正です' };
  const it = partFolder_(String(part)).getFilesByName(String(asset) + '.asset');
  if (!it.hasNext()) return { ok: true, missing: true };
  const f = it.next();
  return { ok: true, file: fileInfo_(f, part + '/'), content: f.getBlob().getDataAsString() };
}

/**
 * 譜面を保存する（パートのフォルダの「アセット名.asset」。あれば上書き）。
 * baseUpdated（前に読んだ・保存したときの更新日時）と今の更新日時が違えば、ほかの人が先に保存したので force がない限り止める
 */
function saveChart_(req, user, rows, sh, now) {
  const part = String(req.part || ''), asset = String(req.asset || '').trim(), content = String(req.content || '');
  if (PARTS.indexOf(part) < 0) return { ok: false, error: 'パートが不正です' };
  if (!/^[\w\-. ]{1,80}$/.test(asset)) return { ok: false, error: 'アセット名は英数字・_・-・. で 80 文字までにしてください' };
  if (!/MonoBehaviour:/.test(content) || content.length > 5 * 1024 * 1024) return { ok: false, error: '譜面の中身が不正です' };
  const info = chartInfo_(content);
  if (info.part && info.part !== part) return { ok: false, error: 'パートと中身が合いません' };

  const folder = partFolder_(part), name = asset + '.asset';
  const it = folder.getFilesByName(name);
  let file = it.hasNext() ? it.next() : null;
  if (file && !req.force && req.baseUpdated !== file.getLastUpdated().toISOString()) {
    return { ok: false, conflict: true, error: 'ドライブの譜面がほかで更新されています', file: fileInfo_(file, part + '/') };
  }
  if (file) file.setContent(content);
  else file = folder.createFile(name, content, 'text/plain');
  file.setDescription(user);

  // ボードの同じ譜面：未着手なら作成中にする
  rows.filter(r => r.part === part && String(r.asset).toLowerCase() === asset.toLowerCase()).forEach(r => {
    if (r.status === 'todo') r.status = 'doing';
    if (!r.assignee) r.assignee = user;
    r.updatedAt = now; r.updatedBy = user;
    writeRow_(sh, r);
  });
  return { ok: true, file: fileInfo_(DriveApp.getFileById(file.getId()), part + '/') };
}

/** 譜面をゴミ箱フォルダへ移す（ノーツ保存フォルダの中のものだけ）。誰がいつ移したかを説明に残す */
function trashCharts_(ids, user) {
  const trash = DriveApp.getFolderById(TRASH_FOLDER_ID);
  const stamp = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd HH:mm');
  let moved = 0;
  (ids || []).slice(0, 100).forEach(id => {
    const f = DriveApp.getFileById(String(id));
    if (!inFolder_(f, NOTES_FOLDER_ID) || inFolder_(f, TRASH_FOLDER_ID)) return;
    const parents = f.getParents(), from = parents.hasNext() ? parents.next().getName() + '/' : '';
    f.setDescription(`${f.getDescription() || ''}（${stamp} に ${user || '?'} がゴミ箱へ。元の場所: ${from}）`.trim());
    f.moveTo(trash);
    moved++;
  });
  return moved;
}

/** フォルダ（rootId）の中にあるファイルか（親を数段さかのぼって確かめる） */
function inFolder_(file, rootId) {
  let level = [file];
  for (let depth = 0; depth < 5 && level.length; depth++) {
    const next = [];
    for (const item of level) {
      const parents = item.getParents();
      while (parents.hasNext()) {
        const parent = parents.next();
        if (parent.getId() === rootId) return true;
        next.push(parent);
      }
    }
    level = next;
  }
  return false;
}

/** 音源フォルダの中にあるファイルか（親を数段さかのぼって確かめる） */
function inAudioFolder_(file) {
  return inFolder_(file, AUDIO_FOLDER_ID);
}


/** 音声ファイルの中身を offset から AUDIO_CHUNK バイトだけ base64 で返す（大きいファイルは何回かに分けて読む） */
function audioChunk_(id, offset) {
  const file = DriveApp.getFileById(String(id));
  if (!inAudioFolder_(file)) return { ok: false, error: '音源フォルダの外のファイルです' };
  const bytes = file.getBlob().getBytes();
  const end = Math.min(bytes.length, offset + AUDIO_CHUNK);
  return {
    ok: true, id: file.getId(), name: file.getName(), mime: file.getMimeType(), size: bytes.length,
    updated: file.getLastUpdated().toISOString(), offset: offset, next: end < bytes.length ? end : null,
    data: Utilities.base64Encode(bytes.slice(offset, end)),
  };
}

function doPost(e) {
  let req;
  try { req = JSON.parse(e.postData.contents || '{}'); } catch (err) { return json_({ ok: false, error: '不正なリクエスト' }); }
  const key = PropertiesService.getScriptProperties().getProperty('KEY');
  if (key && req.key !== key) return json_({ ok: false, error: 'キーが違います' });
  if (req.action === 'heartbeat') return heartbeat_(req);
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {

    const sh = sheet_();
    const rows = readRows_(sh);
    const now = new Date().toISOString();
    const user = String(req.user || '').slice(0, 40);
    const find = id => rows.find(r => r.id === id);

    switch (req.action) {
      case 'add': {
        const row = { id: Utilities.getUuid().slice(0, 8), status: 'todo' };
        EDITABLE.forEach(k => { if (req.row && req.row[k] != null) row[k] = String(req.row[k]); });
        row.updatedAt = now; row.updatedBy = user;
        sh.appendRow(HEAD.map(k => row[k] == null ? '' : row[k]));
        break;
      }
      case 'addMany': {
        const list = (req.rows || []).slice(0, 50).map(src => {
          const row = { id: Utilities.getUuid().slice(0, 8), status: 'todo' };
          EDITABLE.forEach(k => { if (src[k] != null) row[k] = String(src[k]); });
          row.updatedAt = now; row.updatedBy = user;
          return HEAD.map(k => row[k] == null ? '' : row[k]);
        });
        if (list.length) sh.getRange(sh.getLastRow() + 1, 1, list.length, HEAD.length).setValues(list);
        break;
      }
      case 'update': {
        const r = find(req.id);
        if (!r) return json_({ ok: false, error: '見つかりません' });
        EDITABLE.forEach(k => { if (req.fields && req.fields[k] != null) r[k] = String(req.fields[k]); });
        r.updatedAt = now; r.updatedBy = user;
        writeRow_(sh, r);
        break;
      }
      case 'remove': {
        const r = find(req.id);
        if (r) sh.deleteRow(r._row);
        break;
      }
      case 'trashCharts': {
        const moved = trashCharts_(req.ids, user);
        cdel_(['charts']);
        return json_({ ok: true, moved, files: chartsCached_(true), rows: withLive_(rows), now });
      }
      case 'saveChart': {
        const res = saveChart_(req, user, rows, sh, now);
        cdel_(['charts', 'rows']);
        if (!res.ok) return json_(res);
        return json_({ ok: true, file: res.file, rows: rowsCached_(true), now });
      }
      default:
        return json_({ ok: false, error: '不明な操作: ' + req.action });
    }
    cdel_(['rows']);
    return json_({ ok: true, rows: rowsCached_(true), now });
  } catch (err) {
    return json_({ ok: false, error: String(err) });
  } finally {
    lock.releaseLock();
  }
}

/**
 * エディタで開いている譜面（パート + アセット名）を「編集中」にする（キャッシュに 3 分）。leaving なら解除。
 * 未着手なら作成中にし、担当が空なら自分にする（このときだけシートに書く）
 */
function heartbeat_(req) {
  const user = String(req.user || '').slice(0, 40), now = new Date().toISOString();
  const k = liveKey_(req.part, req.asset);
  if (req.leaving) {
    const cur = cget_(k);
    if (cur && cur.user === user) cdel_([k]);
    return json_({ ok: true, now });
  }
  cput_(k, { user, at: now }, 180);
  const asset = String(req.asset || '').toLowerCase();
  const rows = rowsCached_(false);
  const need = rows.some(r => r.part === req.part && String(r.asset).toLowerCase() === asset && (r.status === 'todo' || !r.assignee));
  if (!need) return json_({ ok: true, rows, now });
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const sh = sheet_();
    readRows_(sh).filter(r => r.part === req.part && String(r.asset).toLowerCase() === asset).forEach(r => {
      if (r.status === 'todo') { r.status = 'doing'; r.updatedAt = now; r.updatedBy = user; }
      if (!r.assignee) r.assignee = user;
      writeRow_(sh, r);
    });
    cdel_(['rows']);
    return json_({ ok: true, rows: rowsCached_(true), now });
  } finally { lock.releaseLock(); }
}

function sheet_() {
  const ss = SpreadsheetApp.getActive();
  let sh = ss.getSheetByName(SHEET_NAME);
  if (!sh) sh = ss.insertSheet(SHEET_NAME);
  if (sh.getLastRow() === 0) {
    sh.appendRow(HEAD);
    sh.setFrozenRows(1);
    sh.getRange(1, 1, 1, HEAD.length).setFontWeight('bold');
  }
  return sh;
}

function readRows_(sh) {
  const last = sh.getLastRow();
  if (last < 2) return [];
  const values = sh.getRange(2, 1, last - 1, HEAD.length).getValues();
  return values.map((v, i) => {
    const r = { _row: i + 2 };
    HEAD.forEach((k, j) => { r[k] = v[j] instanceof Date ? v[j].toISOString() : String(v[j]); });
    return r;
  }).filter(r => r.id);
}

function writeRow_(sh, r) {
  sh.getRange(r._row, 1, 1, HEAD.length).setValues([HEAD.map(k => r[k] == null ? '' : r[k])]);
}

function json_(o) {
  if (o.rows) o.rows = o.rows.map(r => { const c = Object.assign({}, r); delete c._row; return c; });
  if (o.files) o.files = o.files.map(f => { const c = Object.assign({}, f); delete c._row; return c; });
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}
