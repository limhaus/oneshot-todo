// ToDo管理サービス: 依存パッケージなし(Node.js標準機能のみ)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '127.0.0.1';
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'todo.db');
const PUBLIC_DIR = path.join(__dirname, 'public');
const SESSION_DAYS = 30;
const COOKIE = 'sid';

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new DatabaseSync(DB_PATH);
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS todos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    memo TEXT NOT NULL DEFAULT '',
    due_date TEXT,
    done INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_todos_user ON todos(user_id);
`);

// ---------- ユーティリティ ----------
class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const hashToken = (t) => crypto.createHash('sha256').update(t).digest('hex');

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}

function verifyPassword(password, stored) {
  const [saltHex, hashHex] = stored.split(':');
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length);
  return crypto.timingSafeEqual(expected, actual);
}

// ダミーハッシュ(存在しないメールでも同じ時間をかけ、ユーザーの有無を推測されにくくする)
const DUMMY_HASH = hashPassword('dummy-password');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function str(value, field, { min = 0, max, required = false } = {}) {
  const v = typeof value === 'string' ? value.trim() : '';
  if (required && v.length < min) throw new HttpError(400, `${field}を入力してください`);
  if (v.length > max) throw new HttpError(400, `${field}は${max}文字以内で入力してください`);
  return v;
}

function validDate(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string' || !DATE_RE.test(value) || Number.isNaN(Date.parse(value))) {
    throw new HttpError(400, '期限日の形式が正しくありません');
  }
  return value;
}

function validEmail(value) {
  const email = str(value, 'メールアドレス', { min: 1, max: 254, required: true }).toLowerCase();
  if (!EMAIL_RE.test(email)) throw new HttpError(400, 'メールアドレスの形式が正しくありません');
  return email;
}

function validPassword(value) {
  if (typeof value !== 'string' || value.length < 8) {
    throw new HttpError(400, 'パスワードは8文字以上で入力してください');
  }
  if (value.length > 200) throw new HttpError(400, 'パスワードが長すぎます');
  return value;
}

// ---------- セッション ----------
function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function createSession(res, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const maxAge = SESSION_DAYS * 24 * 60 * 60;
  db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)').run(
    hashToken(token),
    userId,
    Date.now() + maxAge * 1000,
  );
  const secure = process.env.COOKIE_SECURE === '1' ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`);
}

function clearCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

function currentUser(req) {
  const token = parseCookies(req)[COOKIE];
  if (!token) return null;
  const row = db
    .prepare(
      `SELECT u.id, u.name, u.email, s.expires_at FROM sessions s
       JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`,
    )
    .get(hashToken(token));
  if (!row) return null;
  if (row.expires_at < Date.now()) {
    db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token));
    return null;
  }
  return { id: row.id, name: row.name, email: row.email };
}

function requireUser(req) {
  const user = currentUser(req);
  if (!user) throw new HttpError(401, 'ログインしてください');
  return user;
}

// ---------- ログイン試行の制限(総当たり対策) ----------
const attempts = new Map(); // key -> { count, resetAt }
const MAX_ATTEMPTS = 10;
const WINDOW_MS = 10 * 60 * 1000;

function checkRate(key) {
  const now = Date.now();
  const a = attempts.get(key);
  if (a && a.resetAt > now && a.count >= MAX_ATTEMPTS) {
    throw new HttpError(429, '試行回数が多すぎます。しばらく待ってからやり直してください');
  }
}
function failRate(key) {
  const now = Date.now();
  const a = attempts.get(key);
  if (!a || a.resetAt <= now) attempts.set(key, { count: 1, resetAt: now + WINDOW_MS });
  else a.count += 1;
}
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of attempts) if (v.resetAt <= now) attempts.delete(k);
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now);
}, 10 * 60 * 1000).unref();

// ---------- API ----------
const todoOut = (r) => ({
  id: r.id,
  title: r.title,
  memo: r.memo,
  dueDate: r.due_date,
  done: !!r.done,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const routes = [];
const route = (method, pattern, handler) =>
  routes.push({ method, re: new RegExp(`^${pattern.replace(/:id/g, '(\\d+)')}$`), handler });

route('POST', '/api/register', (req, res, body, _m, ip) => {
  checkRate(`reg:${ip}`);
  const name = str(body.name, 'ユーザー名', { min: 1, max: 50, required: true });
  const email = validEmail(body.email);
  const password = validPassword(body.password);
  if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) {
    failRate(`reg:${ip}`);
    throw new HttpError(409, 'このメールアドレスはすでに登録されています');
  }
  const info = db
    .prepare('INSERT INTO users (name, email, password_hash) VALUES (?, ?, ?)')
    .run(name, email, hashPassword(password));
  createSession(res, Number(info.lastInsertRowid));
  return { user: { id: Number(info.lastInsertRowid), name, email } };
});

route('POST', '/api/login', (req, res, body, _m, ip) => {
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  const password = typeof body.password === 'string' ? body.password : '';
  const key = `login:${ip}:${email}`;
  checkRate(key);
  const row = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  const ok = verifyPassword(password, row ? row.password_hash : DUMMY_HASH) && row;
  if (!ok) {
    failRate(key);
    throw new HttpError(401, 'メールアドレスまたはパスワードが違います');
  }
  attempts.delete(key);
  createSession(res, row.id);
  return { user: { id: row.id, name: row.name, email: row.email } };
});

route('POST', '/api/logout', (req, res) => {
  const token = parseCookies(req)[COOKIE];
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token));
  clearCookie(res);
  return { ok: true };
});

route('GET', '/api/me', (req) => ({ user: currentUser(req) }));

route('PUT', '/api/me', (req, res, body) => {
  const user = requireUser(req);
  const name = str(body.name, 'ユーザー名', { min: 1, max: 50, required: true });
  const email = validEmail(body.email);
  const dup = db.prepare('SELECT id FROM users WHERE email = ? AND id != ?').get(email, user.id);
  if (dup) throw new HttpError(409, 'このメールアドレスはすでに使われています');
  db.prepare('UPDATE users SET name = ?, email = ? WHERE id = ?').run(name, email, user.id);
  return { user: { id: user.id, name, email } };
});

route('PUT', '/api/me/password', (req, res, body, _m, ip) => {
  const user = requireUser(req);
  const key = `pw:${ip}:${user.id}`;
  checkRate(key);
  const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(user.id);
  const current = typeof body.currentPassword === 'string' ? body.currentPassword : '';
  if (!verifyPassword(current, row.password_hash)) {
    failRate(key);
    throw new HttpError(400, '現在のパスワードが違います');
  }
  const next = validPassword(body.newPassword);
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(next), user.id);
  // 他の端末のセッションは無効化し、今のセッションだけ残す
  const keep = hashToken(parseCookies(req)[COOKIE] || '');
  db.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?').run(user.id, keep);
  return { ok: true };
});

route('GET', '/api/todos', (req) => {
  const user = requireUser(req);
  const rows = db
    .prepare(
      `SELECT * FROM todos WHERE user_id = ?
       ORDER BY done ASC, due_date IS NULL, due_date ASC, id DESC`,
    )
    .all(user.id);
  return { todos: rows.map(todoOut) };
});

route('POST', '/api/todos', (req, res, body) => {
  const user = requireUser(req);
  const title = str(body.title, 'タイトル', { min: 1, max: 200, required: true });
  const memo = str(body.memo, 'メモ', { max: 5000 });
  const due = validDate(body.dueDate);
  const info = db
    .prepare('INSERT INTO todos (user_id, title, memo, due_date) VALUES (?, ?, ?, ?)')
    .run(user.id, title, memo, due);
  const row = db.prepare('SELECT * FROM todos WHERE id = ?').get(info.lastInsertRowid);
  res.statusCode = 201;
  return { todo: todoOut(row) };
});

route('PUT', '/api/todos/:id', (req, res, body, m) => {
  const user = requireUser(req);
  const id = Number(m[1]);
  const row = db.prepare('SELECT * FROM todos WHERE id = ? AND user_id = ?').get(id, user.id);
  if (!row) throw new HttpError(404, 'ToDoが見つかりません');
  const title = 'title' in body ? str(body.title, 'タイトル', { min: 1, max: 200, required: true }) : row.title;
  const memo = 'memo' in body ? str(body.memo, 'メモ', { max: 5000 }) : row.memo;
  const due = 'dueDate' in body ? validDate(body.dueDate) : row.due_date;
  const done = 'done' in body ? (body.done ? 1 : 0) : row.done;
  db.prepare(
    `UPDATE todos SET title = ?, memo = ?, due_date = ?, done = ?, updated_at = datetime('now')
     WHERE id = ? AND user_id = ?`,
  ).run(title, memo, due, done, id, user.id);
  return { todo: todoOut(db.prepare('SELECT * FROM todos WHERE id = ?').get(id)) };
});

route('DELETE', '/api/todos/:id', (req, res, body, m) => {
  const user = requireUser(req);
  const info = db.prepare('DELETE FROM todos WHERE id = ? AND user_id = ?').run(Number(m[1]), user.id);
  if (!info.changes) throw new HttpError(404, 'ToDoが見つかりません');
  return { ok: true };
});

// ---------- HTTPサーバー ----------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'same-origin',
  'Content-Security-Policy':
    "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 100 * 1024) {
        reject(new HttpError(413, 'リクエストが大きすぎます'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
        resolve(parsed);
      } catch {
        reject(new HttpError(400, 'リクエストの形式が正しくありません'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function serveStatic(req, res, pathname) {
  let rel = pathname === '/' ? '/index.html' : pathname;
  let file = path.normalize(path.join(PUBLIC_DIR, decodeURIComponent(rel)));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    // 画面遷移はクライアント側で行うので、拡張子のないパスはindex.htmlを返す
    if (path.extname(rel)) {
      res.writeHead(404).end('Not Found');
      return;
    }
    file = path.join(PUBLIC_DIR, 'index.html');
  }
  res.writeHead(200, {
    'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
    'Cache-Control': 'no-cache',
  });
  fs.createReadStream(file).pipe(res);
}

const server = http.createServer(async (req, res) => {
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
  const url = new URL(req.url, 'http://localhost');
  const pathname = url.pathname;

  if (!pathname.startsWith('/api/')) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405).end('Method Not Allowed');
      return;
    }
    try {
      serveStatic(req, res, pathname);
    } catch {
      res.writeHead(400).end('Bad Request');
    }
    return;
  }

  try {
    // CSRF対策: 書き込み系はJSONのみ受け付け、Originが異なる場合は拒否する
    if (req.method !== 'GET') {
      const origin = req.headers.origin;
      if (origin && new URL(origin).host !== req.headers.host) throw new HttpError(403, '不正なリクエストです');
      if (req.method !== 'DELETE' && !(req.headers['content-type'] || '').startsWith('application/json')) {
        throw new HttpError(415, 'Content-Typeが正しくありません');
      }
    }
    const r = routes.find((x) => x.method === req.method && x.re.test(pathname));
    if (!r) {
      if (routes.some((x) => x.re.test(pathname))) throw new HttpError(405, '許可されていないメソッドです');
      throw new HttpError(404, '見つかりません');
    }
    const body = req.method === 'GET' || req.method === 'DELETE' ? {} : await readBody(req);
    const result = r.handler(req, res, body, pathname.match(r.re), req.socket.remoteAddress);
    sendJson(res, res.statusCode === 200 || res.statusCode === 201 ? res.statusCode : 200, result);
  } catch (err) {
    if (err instanceof HttpError) return sendJson(res, err.status, { error: err.message });
    console.error(err);
    sendJson(res, 500, { error: 'サーバーでエラーが発生しました' });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`ToDoサービスを起動しました: http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    server.close();
    db.close();
    process.exit(0);
  });
}
