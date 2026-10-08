// 名前の入力（config.js の後に読み込む。index.html と各エディタで共通）
// 名前（譜面ボードの担当・保存した人に使う）が入るまで、画面の前に入力欄を出して操作できないようにする。
// ほかのスクリプトからは NameGate.get() / NameGate.ask() で使う
window.NameGate = (function () {
  'use strict';
  const KEY = 'ms2026.chartBoard.user';
  const MAX = 20;
  const CFG = window.CHART_EDITOR_CONFIG || {};
  const get = () => { try { return (localStorage.getItem(KEY) || '').trim(); } catch (e) { return ''; } };
  const set = v => { try { localStorage.setItem(KEY, v); } catch (e) { } };
  const listeners = [];

  const css = document.createElement('style');
  css.textContent = `
#nameGate{width:420px;max-width:92vw;padding:26px 28px 22px;background:var(--panel,#1d1d27);color:var(--text,#e8e8f0);border:1px solid var(--line,#363648);border-radius:16px;box-shadow:0 24px 60px rgba(0,0,0,.6)}
#nameGate::backdrop{background:rgba(8,8,14,.82);backdrop-filter:blur(3px)}
#nameGate h2{margin:0 0 6px;font-size:19px}
#nameGate p{margin:0 0 16px;color:var(--dim,#9696ad);font-size:13px;line-height:1.6}
#nameGate input{width:100%;box-sizing:border-box;font:inherit;font-size:16px;color:inherit;background:#12121a;border:1px solid var(--line,#363648);border-radius:10px;padding:10px 14px;min-height:46px}
#nameGate input:focus{outline:2px solid #ff8a3d;outline-offset:-2px;border-color:transparent}
#nameGate .names{display:flex;flex-wrap:wrap;gap:6px;margin-top:10px}
#nameGate .names button{font:inherit;font-size:12.5px;color:#c8c8d8;background:none;border:1px solid var(--line,#363648);border-radius:14px;padding:4px 12px;min-height:30px;cursor:pointer}
#nameGate .names button:hover{border-color:#ff8a3d;color:#fff}
#nameGate .err{min-height:18px;margin-top:8px;color:#ff9aa8;font-size:12px}
#nameGate .ok{display:block;width:100%;margin-top:6px;font:inherit;font-size:15px;font-weight:700;color:#1a0a12;background:linear-gradient(90deg,#ff66aa,#ff8a3d);border:0;border-radius:10px;min-height:46px;cursor:pointer}
#nameGate .ok:disabled{opacity:.35;cursor:default}
#nameGate .cancel{display:block;margin:10px auto 0;font:inherit;font-size:12px;color:var(--dim,#9696ad);background:none;border:0;cursor:pointer}
#nameGate .cancel[hidden]{display:none}`;
  document.head.append(css);

  const dlg = document.createElement('dialog');
  dlg.id = 'nameGate';
  dlg.innerHTML = `<h2>あなたの名前を入力してください</h2>
    <p>譜面ボードの担当や、譜面を保存した人として記録されます。<br>チームで同じ書き方にそろえてください（下の名前から選べます）。</p>
    <form method="dialog">
      <input type="text" maxlength="${MAX}" placeholder="例: 山田" autocomplete="nickname" spellcheck="false" required>
      <div class="names"></div>
      <div class="err"></div>
      <button class="ok" type="submit" disabled>はじめる</button>
      <button class="cancel" type="button" hidden>キャンセル</button>
    </form>`;
  const input = dlg.querySelector('input'), ok = dlg.querySelector('.ok'), err = dlg.querySelector('.err');
  const namesEl = dlg.querySelector('.names'), cancel = dlg.querySelector('.cancel');
  let required = true;

  const clean = v => String(v || '').replace(/\s+/g, ' ').trim().slice(0, MAX);
  function check() {
    const v = clean(input.value);
    err.textContent = /[<>"&]/.test(v) ? '< > " & は使えません' : '';
    ok.disabled = !v || !!err.textContent;
  }
  input.addEventListener('input', check);
  dlg.addEventListener('cancel', e => { if (required) e.preventDefault(); }); // Esc で閉じさせない
  // ブラウザによっては Esc を止められないので、名前がないまま閉じたらすぐ出し直す
  dlg.addEventListener('close', () => { if (!get()) setTimeout(() => ask(), 0); });
  dlg.addEventListener('keydown', e => e.stopPropagation()); // エディタのショートカットを動かさない
  namesEl.addEventListener('click', e => { const b = e.target.closest('button'); if (b) { input.value = b.textContent; check(); input.focus(); } });
  cancel.addEventListener('click', () => dlg.close());
  dlg.querySelector('form').addEventListener('submit', e => {
    const v = clean(input.value);
    if (!v || err.textContent) { e.preventDefault(); return; }
    set(v);
    listeners.forEach(fn => { try { fn(v); } catch (x) { } });
  });

  // ボードに出てくる名前（担当・更新した人）を候補として出す
  async function loadNames() {
    if (!CFG.boardApiUrl) return;
    try {
      const j = await (await fetch(CFG.boardApiUrl)).json();
      const names = [...new Set((j.rows || []).flatMap(r => [r.assignee, r.updatedBy, r.editingBy]).map(clean).filter(Boolean))].sort().slice(0, 24);
      namesEl.innerHTML = names.map(n => `<button type="button">${n.replace(/[&<>"]/g, '')}</button>`).join('');
    } catch (e) { /* 候補が出ないだけ */ }
  }

  /** 名前の入力欄を出す。force = 名前があっても変更のために出す（そのときはキャンセルできる） */
  function ask(force) {
    if (!force && get()) return;
    required = !get();
    cancel.hidden = required;
    input.value = get(); check();
    if (!dlg.isConnected) document.body.append(dlg);
    if (!dlg.open) dlg.showModal();
    input.focus(); input.select();
    loadNames();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => ask());
  else ask();
  // ほかのタブで名前を消した・変えたとき
  addEventListener('storage', e => { if (e.key === KEY) { if (!get()) ask(); else listeners.forEach(fn => fn(get())); } });

  return { get, ask, onChange: fn => listeners.push(fn) };
})();
