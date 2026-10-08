// Google ドライブの音源フォルダを、譜面ボードの Apps Script 経由で読む（config.js の後に読み込む）
// ・list()  音源フォルダの音声ファイル一覧
// ・load()  ファイルの中身を File にして返す。一度読んだものはブラウザ（IndexedDB）に取っておき、更新されていなければ再ダウンロードしない
window.DriveAudio = (function () {
  'use strict';
  const CFG = window.CHART_EDITOR_CONFIG || {};
  const DB = 'ms2026-drive-audio', STORE = 'files';
  let listCache = null, listAt = 0;

  const enabled = () => !!CFG.boardApiUrl;
  const url = q => CFG.boardApiUrl + (CFG.boardApiUrl.includes('?') ? '&' : '?') + new URLSearchParams(q);
  async function getJSON(q) {
    const j = await (await fetch(url(q))).json();
    if (!j.ok) throw new Error(j.error || '失敗しました');
    return j;
  }

  /** 音源フォルダの一覧（60秒は前回の結果を使う） */
  async function list(force) {
    if (!enabled()) return [];
    if (!force && listCache && Date.now() - listAt < 60000) return listCache;
    const j = await getJSON({ action: 'audioList' });
    listCache = j.files; listAt = Date.now();
    return listCache;
  }

  // ---- IndexedDB（ダウンロードした音源の置き場） ----
  function db() {
    return new Promise((res, rej) => {
      const rq = indexedDB.open(DB, 1);
      rq.onupgradeneeded = () => rq.result.createObjectStore(STORE);
      rq.onsuccess = () => res(rq.result); rq.onerror = () => rej(rq.error);
    });
  }
  async function idb(mode, fn) {
    const d = await db();
    return new Promise((res, rej) => {
      const tx = d.transaction(STORE, mode), r = fn(tx.objectStore(STORE));
      tx.oncomplete = () => res(r && r.result); tx.onerror = () => rej(tx.error);
    });
  }
  async function cached(f) {
    try { const c = await idb('readonly', st => st.get(f.id)); return c && c.updated === f.updated ? c : null; } catch (e) { return null; }
  }

  function b64(s) {
    const bin = atob(s), out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  /** f = list() の1件。onProgress(0〜1) で進み具合を知らせる */
  async function load(f, onProgress = () => { }) {
    const hit = await cached(f);
    if (hit) { onProgress(1); return new File([hit.data], f.name, { type: hit.mime }); }
    const parts = []; let offset = 0, size = f.size || 1, mime = f.mime;
    for (; ;) {
      const j = await getJSON({ action: 'audio', id: f.id, offset });
      parts.push(b64(j.data)); size = j.size; mime = j.mime;
      onProgress(Math.min(1, (j.next ?? size) / size));
      if (j.next == null) break;
      offset = j.next;
    }
    const blob = new Blob(parts, { type: mime });
    try { await idb('readwrite', st => st.put({ updated: f.updated, mime, data: blob }, f.id)); } catch (e) { /* 容量不足などは無視 */ }
    return new File([blob], f.name, { type: mime });
  }

  /** ファイル名 → 曲名（拡張子を外す） */
  const songOf = name => String(name).replace(/\.[^.]+$/, '');
  // 曲名の比べ方：大文字小文字・空白・記号の違いは無視
  const norm = s => String(s).toLowerCase().replace(/[\s_\-・.]+/g, '');
  /** 曲名に合う音源（なければ null） */
  const find = (files, song) => song ? files.find(f => norm(songOf(f.name)) === norm(song)) || null : null;
  const isCached = async f => !!(await cached(f));
  const fmtSize = n => n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB';

  return { enabled, list, load, songOf, norm, find, isCached, fmtSize };
})();
