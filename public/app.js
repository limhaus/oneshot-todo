const app = document.getElementById('app');
const toastEl = document.getElementById('toast');

const state = {
  user: null,
  todos: [],
  filter: 'open', // open | done | all
  editingId: null,
};

// ---------- 共通 ----------
function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === false || v === null || v === undefined) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'class') el.className = v;
    else if (k in el && k !== 'list') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return el;
}

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  let data = {};
  try { data = await res.json(); } catch { /* 本文なし */ }
  if (!res.ok) {
    if (res.status === 401 && state.user) {
      state.user = null;
      render();
    }
    throw new Error(data.error || 'エラーが発生しました');
  }
  return data;
}

let toastTimer;
function toast(msg) {
  toastEl.textContent = msg;
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toastEl.hidden = true; }, 2400);
}

function todayStr() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function formatDate(s) {
  const [y, m, d] = s.split('-').map(Number);
  const w = ['日', '月', '火', '水', '木', '金', '土'][new Date(y, m - 1, d).getDay()];
  return `${y}年${m}月${d}日(${w})`;
}

function field(label, input, hint) {
  return h('div', { class: 'field' },
    h('label', { htmlFor: input.id }, label),
    input,
    hint && h('span', { class: 'hint' }, hint));
}

function errorBox() {
  return h('div', { class: 'error', role: 'alert', hidden: true });
}
function showError(box, msg) {
  box.textContent = msg;
  box.hidden = false;
}

// 送信中はボタンを無効化して二重送信を防ぐ
async function submitting(btn, fn) {
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = '処理中…';
  try { await fn(); } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
}

// ---------- 画面: 認証 ----------
function renderAuth(mode = 'login') {
  const isLogin = mode === 'login';
  const err = errorBox();
  const email = h('input', { class: 'input', id: 'email', type: 'email', name: 'email', autocomplete: 'email', required: true, inputMode: 'email' });
  const password = h('input', { class: 'input', id: 'password', type: 'password', name: 'password', required: true, autocomplete: isLogin ? 'current-password' : 'new-password', minLength: isLogin ? 0 : 8 });
  const name = h('input', { class: 'input', id: 'name', type: 'text', name: 'name', required: true, maxLength: 50, autocomplete: 'nickname' });
  const submit = h('button', { class: 'btn btn-primary btn-block', type: 'submit' }, isLogin ? 'ログイン' : '登録してはじめる');

  const form = h('form', {
    novalidate: false,
    onSubmit: async (e) => {
      e.preventDefault();
      err.hidden = true;
      await submitting(submit, async () => {
        try {
          const payload = isLogin
            ? { email: email.value, password: password.value }
            : { name: name.value, email: email.value, password: password.value };
          const { user } = await api('POST', isLogin ? '/api/login' : '/api/register', payload);
          state.user = user;
          await loadTodos();
          render();
        } catch (ex) {
          showError(err, ex.message);
        }
      });
    },
  },
  err,
  !isLogin && field('ユーザー名', name),
  field('メールアドレス', email),
  field('パスワード', password, isLogin ? null : '8文字以上で入力してください'),
  submit);

  const tab = (m, label) => h('button', {
    class: 'tab', type: 'button', role: 'tab', 'aria-selected': String(m === mode),
    onClick: () => renderAuthView(m),
  }, label);

  app.replaceChildren(h('main', { class: 'auth' },
    h('h1', {}, 'シンプルToDo'),
    h('p', { class: 'lead' }, 'やることを、すっきり整理。'),
    h('div', { class: 'card' },
      h('div', { class: 'tabs', role: 'tablist' }, tab('login', 'ログイン'), tab('register', '新規登録')),
      form)));
  (isLogin ? email : name).focus();
}

function renderAuthView(mode) { renderAuth(mode); }

// ---------- 共通: ヘッダー ----------
function header(current) {
  const logoutBtn = h('button', {
    class: 'btn btn-nav btn-small', type: 'button',
    onClick: async () => {
      try { await api('POST', '/api/logout', {}); } catch { /* 無視 */ }
      state.user = null;
      state.todos = [];
      render();
    },
  }, 'ログアウト');

  return h('header', { class: 'header' },
    h('div', { class: 'header-inner' },
      h('div', { class: 'brand' },
        h('span', { class: 'brand-mark', 'aria-hidden': 'true', innerHTML: '<svg viewBox="0 0 32 32"><path d="M9 16.5l5 5 9-10" fill="none" stroke="#fff" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"/></svg>' }),
        'ToDo'),
      h('a', { class: 'btn btn-nav btn-small', href: '/', 'aria-current': current === 'todos' ? 'page' : false, onClick: (e) => { e.preventDefault(); go('/'); } }, 'ToDo'),
      h('a', { class: 'btn btn-nav btn-small', href: '/profile', 'aria-current': current === 'profile' ? 'page' : false, onClick: (e) => { e.preventDefault(); go('/profile'); } }, 'プロフィール'),
      logoutBtn));
}

// ---------- 画面: ToDo ----------
async function loadTodos() {
  state.todos = (await api('GET', '/api/todos')).todos;
}

function todoForm({ todo, onDone }) {
  const err = errorBox();
  const title = h('input', { class: 'input', id: `title-${todo?.id ?? 'new'}`, type: 'text', maxLength: 200, required: true, value: todo?.title ?? '', placeholder: '例: 企画書を送る' });
  const memo = h('textarea', { class: 'input', id: `memo-${todo?.id ?? 'new'}`, maxLength: 5000, placeholder: '詳しいことや補足など' });
  memo.value = todo?.memo ?? '';
  const due = h('input', { class: 'input', id: `due-${todo?.id ?? 'new'}`, type: 'date', value: todo?.dueDate ?? '' });
  const submit = h('button', { class: 'btn btn-primary', type: 'submit' }, todo ? '保存する' : '追加する');

  const form = h('form', {
    onSubmit: async (e) => {
      e.preventDefault();
      err.hidden = true;
      await submitting(submit, async () => {
        try {
          const payload = { title: title.value, memo: memo.value, dueDate: due.value || null };
          if (todo) await api('PUT', `/api/todos/${todo.id}`, payload);
          else await api('POST', '/api/todos', payload);
          await loadTodos();
          onDone(todo ? '保存しました' : '追加しました');
        } catch (ex) {
          showError(err, ex.message);
        }
      });
    },
  },
  err,
  field('タイトル', title),
  h('div', { class: 'row row-2' },
    field('期限日', due),
    h('div')),
  field('メモ', memo),
  h('div', { class: 'form-actions' },
    submit,
    todo && h('button', { class: 'btn', type: 'button', onClick: () => { state.editingId = null; render(); } }, 'キャンセル')));
  return form;
}

function todoItem(todo) {
  if (state.editingId === todo.id) {
    return h('li', { class: 'card' },
      todoForm({ todo, onDone: (msg) => { state.editingId = null; render(); toast(msg); } }));
  }

  const today = todayStr();
  let badge = null;
  if (todo.dueDate) {
    const cls = !todo.done && todo.dueDate < today ? 'badge overdue' : !todo.done && todo.dueDate === today ? 'badge today' : 'badge';
    const prefix = !todo.done && todo.dueDate < today ? '期限切れ ' : !todo.done && todo.dueDate === today ? '今日まで ' : '期限 ';
    badge = h('span', { class: cls }, prefix + formatDate(todo.dueDate));
  }

  const check = h('input', {
    class: 'check', type: 'checkbox', checked: todo.done,
    'aria-label': `「${todo.title}」を${todo.done ? '未完了に戻す' : '完了にする'}`,
    onChange: async (e) => {
      try {
        await api('PUT', `/api/todos/${todo.id}`, { done: e.target.checked });
        await loadTodos();
        render();
      } catch (ex) {
        e.target.checked = !e.target.checked;
        toast(ex.message);
      }
    },
  });

  return h('li', { class: `todo${todo.done ? ' is-done' : ''}` },
    check,
    h('div', {},
      h('div', { class: 'todo-title' }, todo.title),
      todo.memo && h('p', { class: 'todo-memo' }, todo.memo),
      badge && h('div', { class: 'todo-meta' }, badge)),
    h('div', { class: 'todo-actions' },
      h('button', { class: 'btn btn-small', type: 'button', onClick: () => { state.editingId = todo.id; render(); } }, '編集'),
      h('button', {
        class: 'btn btn-small btn-danger', type: 'button',
        onClick: async () => {
          if (!confirm(`「${todo.title}」を削除しますか?`)) return;
          try {
            await api('DELETE', `/api/todos/${todo.id}`);
            await loadTodos();
            render();
            toast('削除しました');
          } catch (ex) { toast(ex.message); }
        },
      }, '削除')));
}

function renderTodos() {
  const counts = {
    open: state.todos.filter((t) => !t.done).length,
    done: state.todos.filter((t) => t.done).length,
    all: state.todos.length,
  };
  const shown = state.todos.filter((t) => state.filter === 'all' || (state.filter === 'done') === t.done);

  const chip = (key, label) => h('button', {
    class: 'chip', type: 'button', 'aria-pressed': String(state.filter === key),
    onClick: () => { state.filter = key; render(); },
  }, `${label} ${counts[key]}`);

  const emptyMsg = {
    open: counts.all ? '未完了のToDoはありません。おつかれさまでした!' : 'まだToDoがありません。上のフォームから追加しましょう。',
    done: '完了したToDoはまだありません。',
    all: 'まだToDoがありません。',
  }[state.filter];

  app.replaceChildren(
    header('todos'),
    h('main', { class: 'container' },
      h('h1', { class: 'page-title' }, `${state.user.name}さんのToDo`),
      h('section', { class: 'card', 'aria-label': 'ToDoを追加' },
        h('h2', { class: 'section-title' }, '新しいToDo'),
        todoForm({ onDone: (msg) => { render(); toast(msg); } })),
      h('div', { class: 'filters', role: 'group', 'aria-label': '表示の絞り込み' },
        chip('open', '未完了'), chip('done', '完了'), chip('all', 'すべて')),
      shown.length
        ? h('ul', { class: 'list' }, shown.map(todoItem))
        : h('div', { class: 'empty' }, emptyMsg)));
}

// ---------- 画面: プロフィール ----------
function renderProfile() {
  const profErr = errorBox();
  const name = h('input', { class: 'input', id: 'p-name', type: 'text', maxLength: 50, required: true, value: state.user.name, autocomplete: 'nickname' });
  const email = h('input', { class: 'input', id: 'p-email', type: 'email', required: true, value: state.user.email, autocomplete: 'email' });
  const profBtn = h('button', { class: 'btn btn-primary', type: 'submit' }, '保存する');

  const profForm = h('form', {
    onSubmit: async (e) => {
      e.preventDefault();
      profErr.hidden = true;
      await submitting(profBtn, async () => {
        try {
          state.user = (await api('PUT', '/api/me', { name: name.value, email: email.value })).user;
          render();
          toast('プロフィールを更新しました');
        } catch (ex) { showError(profErr, ex.message); }
      });
    },
  }, profErr, field('ユーザー名', name), field('メールアドレス', email, 'ログインにはこのメールアドレスを使います'), profBtn);

  const pwErr = errorBox();
  const cur = h('input', { class: 'input', id: 'pw-cur', type: 'password', required: true, autocomplete: 'current-password' });
  const next = h('input', { class: 'input', id: 'pw-new', type: 'password', required: true, minLength: 8, autocomplete: 'new-password' });
  const pwBtn = h('button', { class: 'btn btn-primary', type: 'submit' }, 'パスワードを変更する');
  const pwForm = h('form', {
    onSubmit: async (e) => {
      e.preventDefault();
      pwErr.hidden = true;
      await submitting(pwBtn, async () => {
        try {
          await api('PUT', '/api/me/password', { currentPassword: cur.value, newPassword: next.value });
          cur.value = '';
          next.value = '';
          toast('パスワードを変更しました');
        } catch (ex) { showError(pwErr, ex.message); }
      });
    },
  }, pwErr, field('現在のパスワード', cur), field('新しいパスワード', next, '8文字以上'), pwBtn);

  app.replaceChildren(
    header('profile'),
    h('main', { class: 'container' },
      h('h1', { class: 'page-title' }, 'プロフィール'),
      h('section', { class: 'card' }, h('h2', { class: 'section-title' }, 'ユーザー名とメールアドレス'), profForm),
      h('section', { class: 'card' }, h('h2', { class: 'section-title' }, 'パスワードの変更'), pwForm)));
}

// ---------- ルーティング ----------
function go(path) {
  if (location.pathname !== path) history.pushState({}, '', path);
  state.editingId = null;
  render();
}

function render() {
  if (!state.user) {
    if (location.pathname !== '/') history.replaceState({}, '', '/');
    return renderAuth('login');
  }
  const y = window.scrollY;
  if (location.pathname === '/profile') renderProfile();
  else renderTodos();
  window.scrollTo(0, y);
}

window.addEventListener('popstate', render);

(async function init() {
  try {
    state.user = (await api('GET', '/api/me')).user;
    if (state.user) await loadTodos();
  } catch { state.user = null; }
  render();
})();
