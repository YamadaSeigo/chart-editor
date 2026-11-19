// 途中で BPM が変わる曲のテンポ表（各エディタ・SONG Editor から読み込む）
// ・最初の BPM（SongData.bpm）と、BPM の変化 bpmChanges: [{ beat, bpm }, ...]（beat はその拍から bpm になる。曲の頭が 0 拍目）
// ・拍 ⇔ 秒（Offset を引いたゲーム内時刻）を変換する。0 拍目より前は最初の BPM のまま
// ・ゲーム（Unity）の SongData.bpmChanges と同じ計算
window.Tempo = (function () {
  'use strict';
  const r6 = v => Math.round(v * 1e6) / 1e6;

  /** 変化の並びを整える（拍の順、0 拍以下・同じ拍の重複・BPM が 0 以下は捨てる。同じ拍は後のものを使う） */
  function normalize(list) {
    const m = new Map();
    for (const c of list || []) {
      const b = r6(+(c && (c.beat ?? c.b))), v = +(c && c.bpm);
      if (isFinite(b) && b > 0 && v > 0) m.set(b, r6(v));
    }
    return [...m].sort((a, b) => a[0] - b[0]).map(([beat, bpm]) => ({ beat, bpm }));
  }

  /** テンポ表を作る。segs[i] = { b: 始まる拍, t: 始まる秒, spb: 1拍の秒 } */
  function make(bpm, changes) {
    const base = bpm > 0 ? +bpm : 120, list = normalize(changes);
    const segs = [{ b: 0, t: 0, spb: 60 / base, bpm: base }];
    for (const c of list) {
      const p = segs[segs.length - 1];
      if (Math.abs(c.bpm - p.bpm) < 1e-9) continue; // 同じ BPM への変化は意味がない
      segs.push({ b: c.beat, t: p.t + (c.beat - p.b) * p.spb, spb: 60 / c.bpm, bpm: c.bpm });
    }
    const segB = b => { let i = segs.length - 1; while (i > 0 && segs[i].b > b + 1e-9) i--; return segs[i]; };
    const segT = t => { let i = segs.length - 1; while (i > 0 && segs[i].t > t + 1e-9) i--; return segs[i]; };
    return {
      bpm: base, changes: list, segs, constant: segs.length === 1,
      /** 拍 → 秒 */
      sec(b) { const s = segB(b); return s.t + (b - s.b) * s.spb; },
      /** 秒 → 拍 */
      beat(t) { const s = segT(t); return s.b + (t - s.t) / s.spb; },
      /** その拍の BPM */
      bpmAt(b) { return segB(b).bpm; },
      /** その拍の1拍の長さ（秒） */
      spbAt(b) { return segB(b).spb; },
      /** その秒の1拍の長さ（秒） */
      spbAtT(t) { return segT(t).spb; },
    };
  }

  // 一番最近作った表を使い回す（描画で何度も呼ぶため）
  let lastKey = '', last = null;
  function get(bpm, changes) {
    const key = bpm + '|' + JSON.stringify(changes || []);
    if (key !== lastKey) { last = make(bpm, changes); lastKey = key; }
    return last;
  }

  /** 「64:180, 128:150」（拍:BPM）の書き方 ⇔ 配列 */
  function format(list) { return normalize(list).map(c => `${c.beat}:${c.bpm}`).join(', '); }
  function parse(text) {
    const out = [], bad = [];
    for (const part of String(text || '').split(/[,、\s]+/).filter(Boolean)) {
      const m = part.match(/^(-?\d+(?:\.\d+)?)[:：=](\d+(?:\.\d+)?)$/);
      if (m && +m[1] > 0 && +m[2] > 0) out.push({ beat: +m[1], bpm: +m[2] }); else bad.push(part);
    }
    return { list: normalize(out), bad };
  }

  /**
   * BPM・テンポ表を変えたとき、秒で持っている値（TECH のノーツなど）を拍の位置のまま移す
   * from / to は make() の表
   */
  const remapSec = (t, from, to) => to.sec(from.beat(t));

  // ====== BPM 変化を編集するダイアログ（各エディタ共通） ======
  const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const fmtBeat = b => { const bi = Math.floor(b + 1e-6); return `${Math.floor(bi / 4) + 1}:${bi % 4 + 1}` + (Math.abs(b - bi) > 1e-6 ? `+${r6(b - bi)}` : ''); };
  const fmtSec = t => { const m = Math.floor(t / 60), s = t - m * 60; return String(m).padStart(2, '0') + ':' + s.toFixed(3).padStart(6, '0'); };
  let dlg = null;
  function ensureDialog() {
    if (dlg) return dlg;
    const css = document.createElement('style');
    css.textContent = `
#tempoDlg{width:540px;max-width:94vw;background:var(--panel,#1d1d27);color:var(--text,#e8e8f0);border:1px solid var(--line,#363648);border-radius:12px;padding:16px 18px}
#tempoDlg::backdrop{background:rgba(8,8,14,.6)}
#tempoDlg h3{margin:0 0 4px;font-size:15px}
#tempoDlg p.hint{margin:0 0 10px;color:var(--dim,#9696ad);font-size:12px;line-height:1.6}
#tempoDlg table{width:100%;border-collapse:collapse;font-size:13px;margin-bottom:8px}
#tempoDlg th{color:var(--dim,#9696ad);font-weight:500;text-align:left;padding:3px 6px;font-size:11px}
#tempoDlg td{padding:3px 6px;border-top:1px solid #2a2a38;font-variant-numeric:tabular-nums}
#tempoDlg td.dim{color:var(--dim,#9696ad);font-size:12px}
#tempoDlg input[type=number]{width:90px}
#tempoDlg .tdrow{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:8px}
#tempoDlg .tdrow input[type=text]{flex:1;min-width:200px;font-family:Consolas,monospace}
#tempoDlg .acts{display:flex;justify-content:flex-end;gap:8px;margin-top:14px}
#tempoDlg .err{color:#ff7a7a;font-size:12px;min-height:16px;margin-top:4px}
#tempoDlg button.x{padding:0 8px}`;
    document.head.append(css);
    dlg = document.createElement('dialog');
    dlg.id = 'tempoDlg';
    document.body.append(dlg);
    return dlg;
  }
  /**
   * BPM 変化のダイアログを開く
   * o = { bpm, changes, curBeat, note, onApply(changes) }
   */
  function openEditor(o) {
    const d = ensureDialog();
    let rows = normalize(o.changes).map(c => ({ ...c }));
    const render = () => {
      const tm = make(o.bpm, rows);
      d.innerHTML = `<h3>BPM の変化</h3>
        <p class="hint">曲の途中で BPM が変わるところを入れます。「拍」はその拍から新しい BPM になる位置（曲の頭が 0 拍、4/4 拍子で数えます）。最初の BPM はヘッダーの BPM 欄です。${o.note ? '<br>' + o.note : ''}</p>
        <table><thead><tr><th>拍</th><th>小節:拍</th><th>秒</th><th>BPM</th><th></th></tr></thead><tbody>
        <tr><td class="dim">0</td><td class="dim">1:1</td><td class="dim">${fmtSec(0)}</td><td class="dim">${esc(o.bpm)}（最初）</td><td></td></tr>
        ${rows.map((c, i) => `<tr><td><input type="number" step="0.25" min="0.25" data-i="${i}" data-k="beat" value="${c.beat}"></td>
          <td class="dim">${fmtBeat(c.beat)}</td><td class="dim">${fmtSec(tm.sec(c.beat))}</td>
          <td><input type="number" step="0.01" min="1" data-i="${i}" data-k="bpm" value="${c.bpm}"></td>
          <td><button class="x" data-del="${i}" title="この変化を消す">✕</button></td></tr>`).join('')}
        </tbody></table>
        <div class="tdrow"><button data-act="addHere" title="今の再生位置（${fmtBeat(Math.max(0, Math.round(o.curBeat || 0)))}）に変化を足す">＋ 今の位置に追加</button><button data-act="addEnd">＋ 最後に追加</button></div>
        <div class="tdrow"><label style="font-size:12px;color:var(--dim,#9696ad)">まとめて（拍:BPM をカンマ区切り。SONG Editor とコピーし合えます）</label></div>
        <div class="tdrow"><input type="text" data-act="text" spellcheck="false" value="${esc(format(rows))}" placeholder="例 64:180, 128:150"><button data-act="copy">コピー</button></div>
        <div class="err"></div>
        <div class="acts"><button data-act="cancel">やめる</button><button class="primary" data-act="ok">反映</button></div>`;
    };
    const err = m => { const e = d.querySelector('.err'); if (e) e.textContent = m || ''; };
    render();
    d.oninput = null;
    d.onchange = e => {
      const t = e.target;
      if (t.dataset.act === 'text') {
        const p = parse(t.value);
        if (p.bad.length) { err('読めない書き方: ' + p.bad.join(' ')); return; }
        rows = p.list; render(); return;
      }
      const i = +t.dataset.i, k = t.dataset.k; if (!k || !rows[i]) return;
      const v = +t.value;
      if (!(v > 0)) { err(k === 'beat' ? '拍は 0 より大きくしてください' : 'BPM は 0 より大きくしてください'); return; }
      rows[i][k] = v; rows = normalize(rows); render();
    };
    d.onclick = async e => {
      const b = e.target.closest('button'); if (!b) return;
      if (b.dataset.del != null) { rows.splice(+b.dataset.del, 1); render(); return; }
      const act = b.dataset.act;
      const last = rows.length ? rows[rows.length - 1] : { beat: 0, bpm: o.bpm };
      if (act === 'addHere') {
        const at = Math.max(1, Math.round(o.curBeat || 0));
        rows = normalize([...rows, { beat: at, bpm: make(o.bpm, rows).bpmAt(at) }]); render();
      } else if (act === 'addEnd') { rows = normalize([...rows, { beat: last.beat + 16, bpm: last.bpm }]); render(); }
      else if (act === 'copy') { try { await navigator.clipboard.writeText(format(rows)); b.textContent = 'コピーしました'; } catch (er) { err('コピーできませんでした'); } }
      else if (act === 'cancel') d.close();
      else if (act === 'ok') { d.close(); o.onApply(normalize(rows)); }
    };
    d.showModal();
  }

  /**
   * ボードの行から、この譜面の曲の SongData（ドライブの SONG）を探して BPM・BPM の変化を読む
   * part / asset は今の譜面、rows はボードの行。見つからなければ null
   * → { bpm, bpmChanges, songAsset }
   */
  async function fromSong(part, asset, rows) {
    const DC = window.DriveCharts, DA = window.DriveAudio;
    if (!DC || !DC.enabled() || !asset || !rows) return null;
    const lc = s => String(s || '').toLowerCase(), norm = s => DA ? DA.norm(s || '') : lc(s);
    const row = rows.find(r => r.part === part && lc(r.asset) === lc(asset));
    if (!row) return null;
    const songRow = rows.find(r => r.part === 'SONG' && norm(r.song) === norm(row.song));
    if (!songRow || !songRow.asset) return null;
    const f = DC.find(DC.peek() || [], 'SONG', songRow.asset) || DC.find(await DC.list(), 'SONG', songRow.asset);
    if (!f) return null;
    const j = await DC.read(f.id);
    const o = JSON.parse(j.content);
    if (!o || o.format !== 'ms2026-song' || !(o.bpm > 0)) return null;
    return { bpm: +o.bpm, bpmChanges: normalize(o.bpmChanges), songAsset: songRow.asset };
  }

  return { make, get, normalize, format, parse, remapSec, openEditor, fmtBeat, fromSong };
})();
