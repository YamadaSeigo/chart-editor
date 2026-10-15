// TECH / POWER エディタ用：音源の波形から拍を見つけて、BPM と Offset を自動で合わせる
// ・音の立ち上がり（スペクトルの増え方）を 1 秒あたり 200 回調べて「どこで音が鳴り始めたか」の曲線を作る
// ・その曲線に一番よく重なる一定間隔（= BPM）と位置（= Offset）を探す
// ・曲をいくつかの区間に分けて、区間ごとのずれも出す（後半ほどずれが広がるなら BPM が違う、区間で飛ぶなら曲の途中でテンポが変わっている）
// エディタからは BeatSync.open({ buffer, bpm, offset, apply(bpm, offset, opt), notesInBeats }) を呼ぶ
//   notesInBeats: ノーツを拍で持っているエディタ（POWER）は true。秒で持っているエディタ（TECH）は false で、BPM を変えるときにノーツを動かすかを選べる（opt.moveNotes）
window.BeatSync = (function () {
  'use strict';
  const FPS = 200, MIN_BPM = 60, MAX_BPM = 210, SEG_SEC = 30;
  const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const cache = new WeakMap(); // AudioBuffer → 立ち上がりの曲線

  // ====== 解析 ======
  function fft(re, im) {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const a = -2 * Math.PI / len, wr = Math.cos(a), wi = Math.sin(a), h = len >> 1;
      for (let i = 0; i < n; i += len) {
        let cr = 1, ci = 0;
        for (let k = 0; k < h; k++) {
          const p = i + k, q = p + h, xr = re[q] * cr - im[q] * ci, xi = re[q] * ci + im[q] * cr;
          re[q] = re[p] - xr; im[q] = im[p] - xi; re[p] += xr; im[p] += xi;
          const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t;
        }
      }
    }
  }

  /** ゆっくりした音量の変化を引いて、立ち上がりだけを残す */
  function highpass(env) {
    const n = env.length, R = Math.round(FPS * 0.1), out = new Float32Array(n);
    let sum = 0, cnt = 0, lo = 0, hi = 0;
    for (let i = 0; i < n; i++) {
      while (hi < n && hi <= i + R) { sum += env[hi++]; cnt++; }
      while (lo < i - R) { sum -= env[lo++]; cnt--; }
      out[i] = Math.max(0, env[i] - sum / cnt);
    }
    return out;
  }

  /** 音の立ち上がりの強さ（1 秒あたり FPS 個）。env[i] は音源の時刻 t0 + i / FPS 秒 */
  function onsetEnvelope(buffer) {
    if (cache.has(buffer)) return cache.get(buffer);
    // モノラルにして 2 万 Hz 前後まで間引く（拍を見るにはこれで十分で、計算が速くなる）
    const d = Math.max(1, Math.floor(buffer.sampleRate / 20000)), sr = buffer.sampleRate / d;
    const len = Math.floor(buffer.length / d), x = new Float32Array(len), nch = buffer.numberOfChannels;
    for (let c = 0; c < nch; c++) {
      const ch = buffer.getChannelData(c);
      for (let i = 0; i < len; i++) { let s = 0; for (let j = 0; j < d; j++) s += ch[i * d + j]; x[i] += s / (d * nch); }
    }
    const N = sr > 16000 ? 512 : 256, hop = sr / FPS, half = N >> 1;
    const win = new Float32Array(N); for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / N);
    // 帯域ごとに立ち上がりを測り、それぞれの合計で揃えてから足す
    // （ハイハットのような広い帯域の音が、拍の頭のキックやスネアより強く出てしまわないように。キック・ベースは少し重く見る）
    const BANDS = [[0, 200, 2], [200, 800, 1], [800, 3000, 1], [3000, Infinity, 0.6]];
    const band = new Uint8Array(half); for (let k = 0; k < half; k++) band[k] = BANDS.findIndex(([lo, hi]) => k * sr / N >= lo && k * sr / N < hi);
    const frames = Math.max(0, Math.floor((len - N) / hop) + 1), envs = BANDS.map(() => new Float32Array(frames));
    const re = new Float64Array(N), im = new Float64Array(N), fl = new Float64Array(BANDS.length);
    let prev = new Float32Array(half), cur = new Float32Array(half);
    for (let f = 0; f < frames; f++) {
      const o = Math.round(f * hop);
      for (let i = 0; i < N; i++) { re[i] = x[o + i] * win[i]; im[i] = 0; }
      fft(re, im);
      fl.fill(0);
      for (let k = 1; k < half; k++) {
        const m = Math.log1p(100 * Math.hypot(re[k], im[k]));
        cur[k] = m; if (f && m > prev[k]) fl[band[k]] += m - prev[k];
      }
      for (let j = 0; j < BANDS.length; j++) envs[j][f] = fl[j];
      [prev, cur] = [cur, prev];
    }
    const env = new Float32Array(frames);
    envs.forEach((e, j) => {
      const h = highpass(e); let tot = 0; for (const v of h) tot += v;
      if (tot > 0) for (let i = 0; i < frames; i++) env[i] += h[i] / tot * frames * BANDS[j][2];
    });
    // 1ms ごとの音の大きさ（拍の頭の正確な位置を最後に詰めるときに使う）
    const per = sr / 1000, fine = new Float32Array(Math.floor(len / per));
    for (let j = 0; j < fine.length; j++) {
      let e = 0; const a = Math.round(j * per), b = Math.round((j + 1) * per);
      for (let i = a; i < b; i++) e += x[i] * x[i];
      fine[j] = e / (b - a);
    }
    // フレームの中心で、前のフレームとの差なので半フレーム前
    const res = { env, fine, t0: (half - hop / 2) / sr, dur: buffer.duration };
    cache.set(buffer, res);
    return res;
  }

  /** env[a..b) を bpm の間隔で重ねたときの {mag（重なりの強さ 0〜1）, phase（拍の位置 0〜1拍の秒）} */
  function comb(E, bpm, a = 0, b = E.env.length) {
    const env = E.env, f = bpm / 60, w = 2 * Math.PI * f / FPS, rc = Math.cos(w), rs = -Math.sin(w);
    let zr = Math.cos(-w * a), zi = Math.sin(-w * a), sr = 0, si = 0, tot = 0;
    for (let i = a; i < b; i++) {
      const v = env[i]; sr += v * zr; si += v * zi; tot += v;
      const t = zr * rc - zi * rs; zi = zr * rs + zi * rc; zr = t;
      if ((i & 1023) === 0) { const m = Math.hypot(zr, zi); zr /= m; zi /= m; }
    }
    const P = 60 / bpm, mag = tot > 0 ? Math.hypot(sr, si) / tot : 0;
    // Σ env · e^{-2πi f t} の角度から、拍が鳴っている位置を戻す
    let ph = (-Math.atan2(si, sr) / (2 * Math.PI * f) + E.t0) % P; if (ph < 0) ph += P;
    return { mag, phase: ph, weight: tot };
  }

  function refine(E, lo, hi) {
    const g = (Math.sqrt(5) - 1) / 2, m = b => comb(E, b).mag;
    let a = lo, b = hi, c = b - g * (b - a), d = a + g * (b - a), fc = m(c), fd = m(d);
    for (let k = 0; k < 28; k++) {
      if (fc > fd) { b = d; d = c; fd = fc; c = b - g * (b - a); fc = m(c); }
      else { a = c; c = d; fc = fd; d = a + g * (b - a); fd = m(d); }
    }
    return (a + b) / 2;
  }

  // 一つの山の中を細かく探す（山の幅 ≒ 60 / 曲の長さ BPM）
  function scan(E, lo, hi, step) {
    let best = null; const mags = [];
    for (let b = lo; b <= hi; b += step) {
      const m = comb(E, b).mag; mags.push(m);
      // 遅い・速すぎる BPM を少しだけ不利にする（120 前後が一番自然）
      const s = m * Math.exp(-0.5 * (Math.log2(b / 120) / 1.2) ** 2);
      if (!best || s > best.s) best = { b, s, m };
    }
    if (!best) return null;
    const bpm = refine(E, Math.max(lo, best.b - step), Math.min(hi, best.b + step));
    return { bpm, mag: comb(E, bpm).mag, mags };
  }

  /** 区間ごとの拍のずれ（ms）。基準は全体の位置 */
  function segments(E, bpm, phase) {
    const n = E.env.length, P = 60 / bpm, per = Math.round(SEG_SEC * FPS), out = [];
    let total = 0; for (let i = 0; i < n; i++) total += E.env[i];
    for (let a = 0; a < n; a += per) {
      const b = Math.min(n, a + per);
      if (b - a < per / 3 && out.length) break; // 最後の短い切れ端は前の区間に含めない（少なすぎてあてにならない）
      const r = comb(E, bpm, a, b);
      if (r.weight < total * 0.02 || r.mag < 0.05) { out.push({ t: a / FPS, ms: null }); continue; }
      let dlt = r.phase - phase; dlt -= Math.round(dlt / P) * P;
      out.push({ t: a / FPS, ms: dlt * 1000 });
    }
    return out;
  }

  /**
   * 拍の位置を 1ms 単位で詰める。全部の拍の前後 ±P/4 の音の大きさを重ねて平均し、一番急に大きくなる所を拍の頭とする
   * （立ち上がりの曲線は 23ms の窓で測っているので、そのままだと 10ms ほど早めに出る）
   */
  function attack(E, bpm, phase) {
    const P = 60 / bpm, F = E.fine, W = Math.min(60, Math.floor(P * 1000 / 4)), prof = new Float64Array(W * 2 + 1);
    for (let t = phase; t * 1000 < F.length; t += P) {
      const c = Math.round(t * 1000);
      for (let j = -W; j <= W; j++) { const i = c + j; if (i >= 0 && i < F.length) prof[j + W] += F[i]; }
    }
    // 3ms でならしてから差をとる
    const sm = prof.map((_, i) => (prof[i - 1] ?? prof[i]) + prof[i] + (prof[i + 1] ?? prof[i]));
    let best = 0, at = 0;
    for (let i = 1; i < sm.length; i++) { const dlt = sm[i] - sm[i - 1]; if (dlt > best) { best = dlt; at = i - W; } }
    // 一番急に増えたのは i-1 → i の間。その 1ms の前の端を拍の頭とする
    return best > 0 ? phase + (at - 1) / 1000 : phase;
  }

  /** P の倍数だけずらして、今の Offset に一番近い位置を選ぶ（ノーツが大きく動かないように） */
  const nearest = (phase, P, cur) => phase + Math.round((cur - phase) / P) * P;

  /** 解析の本体。{ bpm, offset, mag, ratio, curOffset, curMag, segCur, segNew } */
  function analyze(buffer, cur, force) {
    const E = onsetEnvelope(buffer), L = Math.max(10, E.env.length / FPS);
    const step = Math.min(0.1, 15 / L);
    const all = scan(E, MIN_BPM, MAX_BPM, step);
    if (!all) return null;
    const med = all.mags.slice().sort((a, b) => a - b)[all.mags.length >> 1] || 1e-9;
    let pick = all;
    if (force > 0) pick = scan(E, force * 0.995, force * 1.005, step / 4) || all; // 「×2」「÷2」で選び直したとき
    // 今の BPM の近く（±3%）にも十分な山があれば、そちらを優先する。
    // 見つかった BPM が今の BPM の 2 倍・半分・1.5 倍などなら、数え方の違いなので今の BPM の側に揃える
    else if (cur.bpm > 0) {
      const loc = scan(E, cur.bpm * 0.97, cur.bpm * 1.03, step);
      const q = loc && all.bpm / loc.bpm, metrical = loc && [2, 3, 4, 1 / 2, 1 / 3, 1 / 4, 3 / 2, 2 / 3].some(k => Math.abs(q / k - 1) < 0.01);
      if (loc && (loc.mag >= all.mag * 0.6 || (metrical && loc.mag >= all.mag * 0.25))) pick = loc;
    }
    let bpm = pick.bpm;
    const pk = comb(E, bpm).mag;
    // 今の BPM や整数の BPM とほとんど変わらないなら、そちらに揃える
    const tidy = [cur.bpm, Math.round(bpm), Math.round(bpm * 2) / 2].filter(b => b > 0 && Math.abs(b - bpm) < 0.06);
    for (const b of tidy) if (comb(E, b).mag >= pk * 0.97) { bpm = b; break; }
    bpm = Math.round(bpm * 1000) / 1000;
    const rn = comb(E, bpm), rc = cur.bpm > 0 ? comb(E, cur.bpm) : rn;
    const offset = nearest(attack(E, bpm, rn.phase), 60 / bpm, cur.offset);
    const curOffset = nearest(attack(E, cur.bpm, rc.phase), 60 / cur.bpm, cur.offset);
    return {
      bpm, offset: Math.round(offset * 1000) / 1000, mag: rn.mag, ratio: rn.mag / med,
      curOffset: Math.round(curOffset * 1000) / 1000, curMag: rc.mag,
      segNew: segments(E, bpm, rn.phase), segCur: segments(E, cur.bpm, rc.phase),
    };
  }

  // ====== 画面 ======
  let dlg = null;
  function ensureDialog() {
    if (dlg) return dlg;
    const st = document.createElement('style');
    st.textContent = `
#beatSyncDlg{width:560px}
#beatSyncDlg .bs-tbl{border-collapse:collapse;margin:6px 0 4px}
#beatSyncDlg .bs-tbl th,#beatSyncDlg .bs-tbl td{padding:4px 18px 4px 0;line-height:1.5;height:auto;vertical-align:middle;position:static;text-align:left;font-variant-numeric:tabular-nums}
#beatSyncDlg .bs-tbl th{color:var(--dim);font-weight:normal;background:none;border:0}
#beatSyncDlg .bs-chg{color:var(--accent);font-weight:bold}
#beatSyncDlg .bs-conf{display:inline-block;padding:0 8px;border-radius:9px;font-size:11.5px;margin-left:6px}
#beatSyncDlg .bs-segs{display:flex;gap:2px;align-items:flex-end;height:64px;margin:6px 0 2px;border-bottom:1px solid var(--line);position:relative}
#beatSyncDlg .bs-segs i{flex:1;position:relative;height:100%}
#beatSyncDlg .bs-segs i b{position:absolute;left:15%;right:15%;border-radius:2px}
#beatSyncDlg .bs-segs .mid{position:absolute;left:0;right:0;top:50%;border-top:1px dashed var(--line)}
#beatSyncDlg .bs-seglbl{display:flex;justify-content:space-between;color:var(--dim);font-size:11px}
#beatSyncDlg .bs-tabs{display:flex;gap:6px;margin-top:10px}
#beatSyncDlg .bs-tabs button.on{border-color:var(--accent);color:var(--accent)}
#beatSyncDlg .bs-ft{display:flex;gap:8px;justify-content:flex-end;margin-top:14px;flex-wrap:wrap}
#beatSyncDlg .bs-note{color:var(--dim);font-size:11.5px;margin:6px 0 0}`;
    document.head.append(st);
    dlg = document.createElement('dialog'); dlg.id = 'beatSyncDlg';
    document.body.append(dlg);
    return dlg;
  }

  const f3 = v => (+v).toFixed(3), fb = v => String(+(+v).toFixed(3));
  const sgn = v => (v >= 0 ? '+' : '−') + Math.abs(v).toFixed(0);
  const mmss = t => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;

  function segHtml(seg) {
    const vals = seg.filter(s => s.ms != null).map(s => Math.abs(s.ms));
    const lim = Math.max(20, ...vals);
    const bars = seg.map(s => {
      if (s.ms == null) return `<i title="${mmss(s.t)}〜 拍がはっきりしない"></i>`;
      const h = Math.abs(s.ms) / lim * 50, col = Math.abs(s.ms) <= 10 ? '#5bd68a' : Math.abs(s.ms) <= 25 ? '#ffd24d' : '#ff6b6b';
      const pos = s.ms >= 0 ? `bottom:50%;height:${h}%` : `top:50%;height:${h}%`;
      return `<i title="${mmss(s.t)}〜  ${sgn(s.ms)} ms（${s.ms >= 0 ? '音が遅い' : '音が早い'}）"><b style="${pos};background:${col}"></b></i>`;
    }).join('');
    const spread = vals.length ? Math.max(...seg.filter(s => s.ms != null).map(s => s.ms)) - Math.min(...seg.filter(s => s.ms != null).map(s => s.ms)) : 0;
    return `<div class="bs-segs"><span class="mid"></span>${bars}</div>
      <div class="bs-seglbl"><span>${mmss(seg[0]?.t || 0)}</span><span>区間ごとのずれ（上: 音が拍より遅い / 下: 早い、±${lim.toFixed(0)}ms）</span><span>${mmss(seg[seg.length - 1]?.t || 0)}〜</span></div>
      <p class="bs-note">${!vals.length || vals.length < seg.length / 2 ? '⚠ この BPM では多くの区間で拍が重なりません。BPM が違う可能性が高いです。' : spread > 30 ? '⚠ 区間によって 30ms 以上ずれています。BPM が違うか、曲の途中でテンポが変わっているかもしれません。' : '区間ごとのずれは小さく、曲全体で拍が揃っています。'}</p>`;
  }

  function open({ buffer, bpm, offset, apply, notesInBeats = true }) {
    const d = ensureDialog();
    if (!buffer) return;
    d.innerHTML = `<h2>拍の自動合わせ</h2><p>音源の波形を解析しています…</p>`;
    if (!d.open) d.showModal();
    let force = 0, view = 'new', r = null, moveNotes = true;
    const run = () => {
      // 画面に「解析中」を出してから重い計算をする
      setTimeout(() => {
        try { r = analyze(buffer, { bpm, offset }, force); } catch (e) { console.error(e); r = null; }
        if (!r) { d.innerHTML = `<h2>拍の自動合わせ</h2><p>拍を見つけられませんでした。</p><div class="bs-ft"><button data-bs="close">閉じる</button></div>`; bind(); return; }
        if (Math.abs(r.bpm - bpm) < 1e-6) view = 'cur';
        render();
      }, 30);
    };
    const render = () => {
      const sameBpm = Math.abs(r.bpm - bpm) < 1e-6;
      const conf = r.ratio > 8 ? ['高', '#2e6b46'] : r.ratio > 4 ? ['中', '#6b5a1f'] : ['低', '#6b2a2a'];
      const dOff = (r.curOffset - offset) * 1000, curBad = !sameBpm && r.curMag < r.mag * 0.5;
      const bpmBtns = `<button data-bs="half" title="見つかった BPM の半分で探し直す">÷2</button><button data-bs="dbl" title="見つかった BPM の 2 倍で探し直す">×2</button>`;
      d.innerHTML = `<h2>拍の自動合わせ</h2>
        <table class="bs-tbl">
          <tr><th></th><th>今の値</th><th>Offset だけ直す</th>${sameBpm ? '' : '<th>BPM も直す</th>'}</tr>
          <tr><th>BPM</th><td>${fb(bpm)}</td><td>${fb(bpm)}</td>${sameBpm ? '' : `<td class="bs-chg">${fb(r.bpm)}</td>`}</tr>
          <tr><th>Offset</th><td>${f3(offset)}</td><td class="${Math.abs(dOff) >= 1 ? 'bs-chg' : ''}">${f3(r.curOffset)}<small>（${sgn(dOff)}ms）</small>${curBad ? '<br><small style="color:#ff6b6b">⚠ 今の BPM では拍が合いません</small>' : ''}</td>${sameBpm ? '' : `<td class="bs-chg">${f3(r.offset)}</td>`}</tr>
        </table>
        <div>検出の確かさ<span class="bs-conf" style="background:${conf[1]}">${conf[0]}</span>
          <small style="color:var(--dim);margin:0 8px">${sameBpm ? 'BPM は今の値と一致しました' : `波形から見つかった BPM は ${fb(r.bpm)}`}</small>${bpmBtns}</div>
        ${sameBpm ? '' : `<div class="bs-tabs"><button data-bs="vcur" class="${view === 'cur' ? 'on' : ''}">BPM ${fb(bpm)} のとき</button><button data-bs="vnew" class="${view === 'new' ? 'on' : ''}">BPM ${fb(r.bpm)} のとき</button></div>`}
        ${segHtml(view === 'cur' || sameBpm ? r.segCur : r.segNew)}
        <p class="bs-note">${notesInBeats ? 'ノーツは拍で保存されているので、適用するとノーツも新しい拍の位置に合わせて動きます。'
          : 'グリッドの上に置いたノーツは、Offset を直すと音の拍に揃います。'}${(sameBpm ? r.curOffset : r.offset) < 0 ? '<br>Offset がマイナスになります（譜面の 0 拍目が音源の始まりより前）。' : ''}</p>
        ${notesInBeats || sameBpm ? '' : `<label class="bs-note" style="display:block"><input type="checkbox" data-bs="move" ${moveNotes ? 'checked' : ''}> BPM を変えるとき、ノーツも新しい BPM の拍の位置に動かす（拍の何拍目にあるかを保つ）</label>`}
        <div class="bs-ft">
          <button data-bs="close">閉じる</button>
          <button data-bs="applyOff" ${sameBpm ? 'class="primary"' : ''}>Offset だけ適用</button>
          ${sameBpm ? '' : '<button data-bs="applyAll" class="primary">BPM と Offset を適用</button>'}
        </div>`;
      bind();
    };
    const bind = () => d.querySelectorAll('[data-bs]').forEach(b => b.onclick = () => {
      const a = b.dataset.bs;
      if (a === 'move') moveNotes = b.checked;
      else if (a === 'close') d.close();
      else if (a === 'vcur' || a === 'vnew') { view = a.slice(1); render(); }
      else if (a === 'half' || a === 'dbl') {
        force = r.bpm * (a === 'half' ? 0.5 : 2); view = 'new';
        d.innerHTML = `<h2>拍の自動合わせ</h2><p>BPM ${fb(force)} 付近で探し直しています…</p>`; run();
      }
      else if (a === 'applyOff') { d.close(); apply(bpm, r.curOffset, { moveNotes: false }); }
      else if (a === 'applyAll') { d.close(); apply(r.bpm, r.offset, { moveNotes: !notesInBeats && moveNotes }); }
    });
    run();
  }

  return { analyze, open };
})();
