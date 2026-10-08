// Google ドライブのノーツ保存フォルダの譜面（.asset）を、譜面ボードの Apps Script 経由で読み書きする（config.js の後に読み込む）
// ・list()  保存されている譜面の一覧（パート・アセット名・ノーツ数・保存した人・更新日時）
// ・read()  譜面の中身
// ・save()  保存（同じアセット名があれば上書き。ほかの人が先に保存していたら conflict を返す）
window.DriveCharts = (function () {
  'use strict';
  const CFG = window.CHART_EDITOR_CONFIG || {};
  const BASE_KEY = 'ms2026.driveBase.'; // 最後に読んだ・保存したときのドライブの更新日時（上書きの確認に使う）
  let listCache = null, listAt = 0;

  const enabled = () => !!CFG.boardApiUrl;
  const url = q => CFG.boardApiUrl + (CFG.boardApiUrl.includes('?') ? '&' : '?') + new URLSearchParams(q);
  async function getJSON(q) {
    const j = await (await fetch(url(q))).json();
    if (!j.ok) throw new Error(j.error || '失敗しました');
    return j;
  }

  async function list(force) {
    if (!enabled()) return [];
    if (!force && listCache && Date.now() - listAt < 30000) return listCache;
    const j = await getJSON({ action: 'charts' });
    listCache = j.files; listAt = Date.now();
    return listCache;
  }
  async function read(id) {
    const j = await getJSON({ action: 'chart', id });
    setBase(j.file.part, j.file.asset, j.file.updated);
    return j;
  }
  /** { part, asset, content, user, force } → { ok, file, rows } または { ok:false, conflict, file } */
  async function save(o) {
    const body = { key: CFG.boardKey, action: 'saveChart', baseUpdated: getBase(o.part, o.asset), ...o };
    const j = await (await fetch(CFG.boardApiUrl, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(body) })).json();
    if (j.ok) { setBase(o.part, o.asset, j.file.updated); listCache = null; }
    return j;
  }

  const baseKey = (part, asset) => BASE_KEY + part + '.' + String(asset).toLowerCase();
  function getBase(part, asset) { try { return localStorage.getItem(baseKey(part, asset)) || ''; } catch (e) { return ''; } }
  function setBase(part, asset, updated) { try { localStorage.setItem(baseKey(part, asset), updated); } catch (e) { } }

  /** ボードの行に合うファイル */
  const find = (files, part, asset) => files.find(f => f.part === part && f.asset.toLowerCase() === String(asset).toLowerCase()) || null;
  const fmtDate = iso => { const d = new Date(iso); return isNaN(d) ? '' : `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };

  return { enabled, list, read, save, find, fmtDate };
})();
