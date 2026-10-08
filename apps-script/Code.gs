/**
 * MS2026 譜面ボード（Google スプレッドシートに貼り付ける Apps Script）
 *
 * 「作るべき譜面のリスト」と「誰がどの譜面を作成中か」を charts シートに保存し、
 * chart-editor のページ（index.html / 各エディタ）から読み書きする。
 * 設定方法は BOARD_SETUP.md を参照。
 */
const SHEET_NAME = 'charts';
const HEAD = ['id', 'part', 'song', 'difficulty', 'asset', 'status', 'assignee', 'due', 'note',
  'updatedAt', 'updatedBy', 'editingBy', 'editingAt'];
const EDITABLE = ['part', 'song', 'difficulty', 'asset', 'status', 'assignee', 'due', 'note'];

function doGet() {
  return json_({ ok: true, rows: readRows_(sheet_()), now: new Date().toISOString() });
}

function doPost(e) {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const req = JSON.parse(e.postData.contents || '{}');
    const key = PropertiesService.getScriptProperties().getProperty('KEY');
    if (key && req.key !== key) return json_({ ok: false, error: 'キーが違います' });

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
      case 'heartbeat': {
        // エディタで開いている譜面（パート + アセット名）を「作成中」にする。leaving なら解除
        const asset = String(req.asset || '').toLowerCase();
        rows.filter(r => r.part === req.part && String(r.asset).toLowerCase() === asset).forEach(r => {
          if (req.leaving) {
            if (r.editingBy === user) { r.editingBy = ''; r.editingAt = ''; writeRow_(sh, r); }
            return;
          }
          r.editingBy = user; r.editingAt = now;
          if (r.status === 'todo') { r.status = 'doing'; r.updatedAt = now; r.updatedBy = user; }
          if (!r.assignee) r.assignee = user;
          writeRow_(sh, r);
        });
        break;
      }
      default:
        return json_({ ok: false, error: '不明な操作: ' + req.action });
    }
    return json_({ ok: true, rows: readRows_(sh), now });
  } catch (err) {
    return json_({ ok: false, error: String(err) });
  } finally {
    lock.releaseLock();
  }
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
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}
