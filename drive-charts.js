// Google ドライブのノーツ保存フォルダの譜面（.asset）を、譜面ボードの Apps Script 経由で読み書きする（config.js の後に読み込む）
// ・list()  保存されている譜面の一覧（パート・アセット名・ノーツ数・保存した人・更新日時）
// ・read()  譜面の中身
// ・save()  保存（同じアセット名があれば上書き。ほかの人が先に保存していたら conflict を返す）
// ・trash() ゴミ箱フォルダへ移す
// ・byAsset() アセット名で1回で開く（一覧を作らない）
// 前回の一覧はブラウザに残し、peek() ですぐ使える
window.DriveCharts = (function () {
  'use strict';
  const CFG = window.CHART_EDITOR_CONFIG || {};
  const BASE_KEY = 'ms2026.driveBase.'; // 最後に読んだ・保存したときのドライブの更新日時（上書きの確認に使う）
  const LIST_KEY = 'ms2026.chartList';
  let listCache = null, listAt = 0;

  const enabled = () => !!CFG.boardApiUrl;
  const url = q => CFG.boardApiUrl + (CFG.boardApiUrl.includes('?') ? '&' : '?') + new URLSearchParams(q);
  async function getJSON(q) {
    const j = await (await fetch(url(q))).json();
    if (!j.ok) throw new Error(j.error || '失敗しました');
    return j;
  }

  /** 前回の一覧（ブラウザに残っているもの。なければ []） */
  function peek() {
    if (listCache) return listCache;
    try { return JSON.parse(localStorage.getItem(LIST_KEY)) || []; } catch (e) { return []; }
  }
  function remember(files) {
    listCache = files; listAt = Date.now();
    try { localStorage.setItem(LIST_KEY, JSON.stringify(files)); } catch (e) { }
  }
  async function list(force) {
    if (!enabled()) return [];
    if (!force && listCache && Date.now() - listAt < 30000) return listCache;
    const j = await getJSON(force ? { action: 'charts', fresh: '1' } : { action: 'charts' });
    remember(j.files);
    return listCache;
  }
  /** アセット名で開く → { ok, file, content } または { ok, missing:true }。古い Apps Script のときは一覧から探す */
  async function byAsset(part, asset) {
    const j = await getJSON({ action: 'chartByAsset', part, asset });
    if (j.missing) return j;
    if (j.content == null) { // 古いデプロイ（chartByAsset がない）
      const f = find(await list(true), part, asset);
      return f ? read(f.id) : { ok: true, missing: true };
    }
    setBase(j.file.part || part, j.file.asset, j.file.updated);
    return j;
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
    if (j.ok) { setBase(o.part, o.asset, j.file.updated); listCache = null; listAt = 0; }
    return j;
  }

  /** 譜面ファイルをゴミ箱フォルダへ移す → { ok, moved, files } */
  async function trash(ids, user) {
    const body = { key: CFG.boardKey, action: 'trashCharts', ids, user };
    const j = await (await fetch(CFG.boardApiUrl, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(body) })).json();
    if (!j.ok) throw new Error(j.error || '失敗しました');
    remember(j.files);
    return j;
  }

  const baseKey = (part, asset) => BASE_KEY + part + '.' + String(asset).toLowerCase();
  function getBase(part, asset) { try { return localStorage.getItem(baseKey(part, asset)) || ''; } catch (e) { return ''; } }
  function setBase(part, asset, updated) { try { localStorage.setItem(baseKey(part, asset), updated); } catch (e) { } }

  /** ボードの行に合うファイル */
  const find = (files, part, asset) => files.find(f => f.part === part && f.asset.toLowerCase() === String(asset).toLowerCase()) || null;
  const fmtDate = iso => { const d = new Date(iso); return isNaN(d) ? '' : `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };

  return { enabled, list, peek, remember, read, byAsset, save, trash, find, fmtDate };
})();
