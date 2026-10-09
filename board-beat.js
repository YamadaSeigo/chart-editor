// SHIFT / SYNC Editor・SONG Editor 用：譜面ボードに「○○ が編集中」を知らせる（config.js・name-gate.js の後に読み込む）
// TECH / POWER のエディタは board.js が同じことをする。ボードの行（パート + アセット名）がエディタの名前と同じときだけ表示される
// 使い方: BoardBeat({ part: 'SHIFTSYNC', asset: () => 今のアセット名 })
window.BoardBeat = function (opt) {
  'use strict';
  const CFG = window.CHART_EDITOR_CONFIG || {};
  const BEAT_MS = 60 * 1000;
  if (!CFG.boardApiUrl) return;
  const user = () => (window.NameGate ? NameGate.get() : '');
  const asset = () => String(opt.asset() || '').trim();
  const body = extra => JSON.stringify({ key: CFG.boardKey, action: 'heartbeat', part: opt.part, asset: asset(), user: user(), ...extra });

  async function beat() {
    // 名前を設定していて、画面を見ているときだけ
    if (!user() || !asset() || document.visibilityState !== 'visible') return;
    try { await fetch(CFG.boardApiUrl, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: body() }); }
    catch (e) { /* オフラインなどは無視 */ }
  }
  function leave(name) {
    if (!user() || !name) return;
    const b = JSON.stringify({ key: CFG.boardKey, action: 'heartbeat', leaving: true, part: opt.part, asset: name, user: user() });
    try { navigator.sendBeacon(CFG.boardApiUrl, new Blob([b], { type: 'text/plain;charset=utf-8' })); } catch (e) { }
  }
  // 名前が変わったら、前の名前の「編集中」を解除してすぐ知らせる
  let last = asset();
  setInterval(() => {
    const now = asset();
    if (now !== last) { leave(last); last = now; beat(); }
  }, 1000);
  setInterval(beat, BEAT_MS);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') beat(); });
  addEventListener('pagehide', () => leave(asset()));
  if (window.NameGate) NameGate.onChange(beat);
  setTimeout(beat, 1500);
};
