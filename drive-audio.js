// Google ドライブの音源フォルダを、譜面ボードの Apps Script 経由で読む（config.js の後に読み込む）
// ・list()  音源フォルダの音声ファイル一覧
// ・load()  ファイルの中身を File にして返す。一度読んだものはブラウザ（IndexedDB）に取っておき、更新されていなければ再ダウンロードしない
window.DriveAudio = (function () {
  'use strict';
  const CFG = window.CHART_EDITOR_CONFIG || {};
  const DB = 'ms2026-drive-audio', STORE = 'files';
  const LIST_KEY = 'ms2026.driveAudio.list'; // 前回の一覧（開いてすぐ出すため）
  const CHUNK = 6 * 1024 * 1024; // Apps Script の AUDIO_CHUNK と同じ大きさ（違っていても読めるが、並行して読めるのは同じときだけ）
  const PARALLEL = 4; // 同時に取りに行く数
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
    const j = await getJSON(force ? { action: 'audioList', force: 1 } : { action: 'audioList' });
    listCache = j.files; listAt = Date.now();
    try { localStorage.setItem(LIST_KEY, JSON.stringify(listCache)); } catch (e) { }
    return listCache;
  }
  /** 前回読んだ一覧（ブラウザに残っているもの。なければ null）。最新は list() で読む */
  function peek() {
    if (!enabled()) return null;
    if (listCache) return listCache;
    try { return JSON.parse(localStorage.getItem(LIST_KEY)) || null; } catch (e) { return null; }
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
    // 大きさは一覧で分かっているので、分けた分を何個か同時に取りに行く
    let size = f.size || 0, mime = f.mime, got = 0;
    const parts = new Map(); // offset → { end, data }
    const fetchAt = async offset => {
      const j = await getJSON({ action: 'audio', id: f.id, offset });
      const data = b64(j.data);
      size = j.size; mime = j.mime;
      parts.set(offset, { end: j.next ?? j.size, data });
      got += data.length; onProgress(Math.min(1, got / (size || 1)));
      return j;
    };
    const offsets = [];
    for (let o = 0; o < size; o += CHUNK) offsets.push(o);
    if (!offsets.length) offsets.push(0);
    let i = 0;
    await Promise.all(Array.from({ length: Math.min(PARALLEL, offsets.length) }, async () => {
      while (i < offsets.length) await fetchAt(offsets[i++]);
    }));
    // つなげる（Apps Script 側の分け方が違ったときは、足りないところを順に読む）
    const out = [];
    for (let pos = 0; pos < size;) {
      if (!parts.has(pos)) await fetchAt(pos);
      const p = parts.get(pos);
      if (p.end <= pos) break;
      out.push(p.end - pos < p.data.length ? p.data.subarray(0, p.end - pos) : p.data);
      pos = p.end;
    }
    onProgress(1);
    const blob = new Blob(out, { type: mime });
    try { await idb('readwrite', st => st.put({ updated: f.updated, mime, data: blob }, f.id)); } catch (e) { /* 容量不足などは無視 */ }
    return new File([blob], f.name, { type: mime });
  }

  /** ファイル名 → 曲名（拡張子を外す） */
  const songOf = name => String(name).replace(/\.[^.]+$/, '');
  // 曲名の比べ方：大文字小文字・空白・記号の違いは無視
  const norm = s => String(s).toLowerCase().replace(/[\s_\-・.]+/g, '');
  /** 曲名に合う音源（なければ null） */
  const find = (files, song) => song ? files.find(f => norm(songOf(f.name)) === norm(song)) || null : null;
  /** 曲名・ファイル名から BPM を読む（最後の「_150」「 150」、または「150bpm」）。分からなければ null */
  function bpmOf(name) {
    const s = String(name || '').replace(/\.(mp3|wav|ogg|m4a|aac|flac|opus|webm)$/i, '').trim();
    const m = s.match(/(\d{2,3}(?:\.\d+)?)\s*bpm/i) || s.match(/[\s_\-]+(\d{2,3}(?:\.\d+)?)$/);
    const v = m ? +m[1] : NaN;
    return v >= 40 && v <= 400 ? v : null;
  }
  const isCached = async f => !!(await cached(f));
  const fmtSize = n => n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB';

  return { enabled, list, peek, load, songOf, norm, find, isCached, fmtSize, bpmOf };
})();
