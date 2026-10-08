// Google ドライブの音源フォルダを読む（config.js の後に読み込む）
// ・list()  音源フォルダの音声ファイル一覧（前回の一覧はブラウザに残し、peek() ですぐ使える）
// ・load()  ファイルの中身を File にして返す。一度読んだものはブラウザ（IndexedDB）に取っておき、更新されていなければ再ダウンロードしない
//   config.js の driveApiKey があればドライブから直接ダウンロード（速い）。なければ Apps Script から分けて並行に読む
window.DriveAudio = (function () {
  'use strict';
  const CFG = window.CHART_EDITOR_CONFIG || {};
  const DB = 'ms2026-drive-audio', STORE = 'files', LIST_KEY = 'ms2026.audioList';
  const PARALLEL = 3; // Apps Script から読むときに同時に取りに行く数
  let listCache = null, listAt = 0;
  const inflight = new Map(); // 読み込み中のファイル（同じファイルを二重に取りに行かない）

  const enabled = () => !!CFG.boardApiUrl;
  const url = q => CFG.boardApiUrl + (CFG.boardApiUrl.includes('?') ? '&' : '?') + new URLSearchParams(q);
  async function getJSON(q) {
    const j = await (await fetch(url(q))).json();
    if (!j.ok) throw new Error(j.error || '失敗しました');
    return j;
  }

  /** 前回の一覧（ブラウザに残っているもの。なければ []）。画面をすぐ出すのに使う */
  function peek() {
    if (listCache) return listCache;
    try { return JSON.parse(localStorage.getItem(LIST_KEY)) || []; } catch (e) { return []; }
  }
  function remember(files) {
    listCache = files; listAt = Date.now();
    try { localStorage.setItem(LIST_KEY, JSON.stringify(files)); } catch (e) { }
  }
  /** 音源フォルダの一覧（60秒は前回の結果を使う）。force で読み直し（サーバーのキャッシュも使わない） */
  async function list(force) {
    if (!enabled()) return [];
    if (!force && listCache && Date.now() - listAt < 60000) return listCache;
    const j = await getJSON(force ? { action: 'audioList', fresh: '1' } : { action: 'audioList' });
    remember(j.files);
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

  // ドライブから直接（Drive API。ファイルが「リンクを知っている全員」に共有されていること）
  async function direct(f, onProgress) {
    const res = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(f.id)}?alt=media&key=${encodeURIComponent(CFG.driveApiKey)}`);
    if (!res.ok) throw new Error('Drive API ' + res.status);
    const total = +res.headers.get('content-length') || f.size || 0;
    if (!res.body || !total) return res.blob();
    const reader = res.body.getReader(), chunks = []; let got = 0;
    for (; ;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value); got += value.length; onProgress(got / total);
    }
    return new Blob(chunks, { type: f.mime || res.headers.get('content-type') || '' });
  }

  // Apps Script から：最初の1回で大きさと区切りを知り、残りは並行して取りに行く
  async function viaScript(f, onProgress) {
    const first = await getJSON({ action: 'audio', id: f.id, offset: 0 });
    const size = first.size, parts = [b64(first.data)];
    let got = parts[0].length; onProgress(got / size);
    if (first.next != null) {
      const step = first.next, offsets = [];
      for (let o = first.next; o < size; o += step) offsets.push(o);
      const rest = new Array(offsets.length);
      let i = 0;
      const worker = async () => {
        while (i < offsets.length) {
          const k = i++;
          const j = await getJSON({ action: 'audio', id: f.id, offset: offsets[k] });
          rest[k] = b64(j.data); got += rest[k].length; onProgress(Math.min(1, got / size));
        }
      };
      await Promise.all(Array.from({ length: Math.min(PARALLEL, offsets.length) }, worker));
      parts.push(...rest);
    }
    return new Blob(parts, { type: first.mime || f.mime });
  }

  /** f = list() の1件。onProgress(0〜1) で進み具合を知らせる */
  async function load(f, onProgress = () => { }) {
    const hit = await cached(f);
    if (hit) { onProgress(1); return new File([hit.data], f.name, { type: hit.mime }); }
    if (inflight.has(f.id)) { const blob = await inflight.get(f.id); onProgress(1); return new File([blob], f.name, { type: blob.type }); }
    const job = (async () => {
      let blob = null;
      if (CFG.driveApiKey) { try { blob = await direct(f, onProgress); } catch (e) { console.warn('[DriveAudio] 直接ダウンロードできないので Apps Script から読みます', e); } }
      if (!blob) blob = await viaScript(f, onProgress);
      try { await idb('readwrite', st => st.put({ updated: f.updated, mime: blob.type, data: blob }, f.id)); } catch (e) { /* 容量不足などは無視 */ }
      return blob;
    })();
    inflight.set(f.id, job);
    try { const blob = await job; return new File([blob], f.name, { type: blob.type }); }
    finally { inflight.delete(f.id); }
  }

  /** ファイル名 → 曲名（拡張子を外す） */
  const songOf = name => String(name).replace(/\.[^.]+$/, '');
  // 曲名の比べ方：大文字小文字・空白・記号の違いは無視
  const norm = s => String(s).toLowerCase().replace(/[\s_\-・.]+/g, '');
  /** 曲名に合う音源（なければ null） */
  const find = (files, song) => song ? files.find(f => norm(songOf(f.name)) === norm(song)) || null : null;
  const isCached = async f => !!(await cached(f));
  const fmtSize = n => n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB';

  return { enabled, list, peek, remember, load, songOf, norm, find, isCached, fmtSize };
})();
