const path = require('path');
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const { Server } = require('socket.io');
const Database = require('better-sqlite3');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const ADMIN_PIN = process.env.ADMIN_PIN || '1234';
const ADMIN_TOKEN = crypto.randomBytes(32).toString('hex');
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'queue.db');
const COUNTERS = [
  { id: 1, name: '1 號櫃檯' },
  { id: 2, name: '2 號櫃檯' }
];

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);

db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 5000');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS tickets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    number INTEGER NOT NULL UNIQUE,
    status TEXT NOT NULL CHECK (status IN ('waiting', 'called', 'no_show', 'done', 'cancelled')),
    created_at TEXT NOT NULL,
    called_at TEXT,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS system_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    current_number INTEGER,
    last_issued_number INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS counters (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    current_number INTEGER,
    recall_number INTEGER,
    updated_at TEXT NOT NULL
  );
`);

function ensureColumn(table, column, definition) {
  const exists = db.prepare(`PRAGMA table_info(${table})`).all().some((row) => row.name === column);
  if (!exists) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

ensureColumn('tickets', 'from_counter_id', 'INTEGER');
ensureColumn('system_state', 'last_event_type', 'TEXT');
ensureColumn('system_state', 'last_event_counter_id', 'INTEGER');
ensureColumn('system_state', 'last_event_number', 'INTEGER');
ensureColumn('system_state', 'last_event_announcement_text', 'TEXT');
ensureColumn('system_state', 'last_event_timestamp', 'TEXT');

const now = () => new Date().toISOString();
const announcementText = (number, counterId) => `${number}號請到${counterId}號櫃檯辦理`;

const initState = db.transaction(() => {
  const timestamp = now();
  const existing = db.prepare('SELECT id FROM system_state WHERE id = 1').get();
  if (!existing) {
    db.prepare(`
      INSERT INTO system_state (id, current_number, last_issued_number, updated_at)
      VALUES (1, NULL, 0, ?)
    `).run(timestamp);
  }

  COUNTERS.forEach((counter) => {
    db.prepare(`
      INSERT INTO counters (id, name, current_number, recall_number, updated_at)
      VALUES (?, ?, NULL, NULL, ?)
      ON CONFLICT(id) DO UPDATE SET name = excluded.name
    `).run(counter.id, counter.name, timestamp);
  });
});

initState();

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    service: 'lan-queue-system',
    time: now()
  });
});

function parseCounterId(value) {
  const counterId = Number(value);
  if (!Number.isInteger(counterId) || !COUNTERS.some((counter) => counter.id === counterId)) return null;
  return counterId;
}

function noShowView(row) {
  return {
    id: row.id,
    number: row.number,
    fromCounterId: row.from_counter_id,
    updated_at: row.updated_at
  };
}

function lastEventView(state) {
  if (!state.last_event_type) return null;
  return {
    type: state.last_event_type,
    counterId: state.last_event_counter_id,
    number: state.last_event_number,
    announcementText: state.last_event_announcement_text,
    timestamp: state.last_event_timestamp
  };
}

function getState() {
  const state = db.prepare(`
    SELECT
      last_issued_number,
      updated_at,
      last_event_type,
      last_event_counter_id,
      last_event_number,
      last_event_announcement_text,
      last_event_timestamp
    FROM system_state
    WHERE id = 1
  `).get();

  const counters = db.prepare(`
    SELECT id, name, current_number, recall_number
    FROM counters
    ORDER BY id ASC
  `).all().map((counter) => ({
    id: counter.id,
    name: counter.name,
    currentNumber: counter.current_number,
    recallNumber: counter.recall_number
  }));

  const noShowList = db.prepare(`
    SELECT id, number, from_counter_id, updated_at
    FROM tickets
    WHERE status = 'no_show'
    ORDER BY updated_at ASC, id ASC
  `).all().map(noShowView);

  return {
    counters,
    lastCalledNumber: state.last_issued_number,
    noShowList,
    lastEvent: lastEventView(state),
    updatedAt: state.updated_at
  };
}

function setLastEvent(type, counterId, number, timestamp) {
  db.prepare(`
    UPDATE system_state
    SET
      last_event_type = ?,
      last_event_counter_id = ?,
      last_event_number = ?,
      last_event_announcement_text = ?,
      last_event_timestamp = ?,
      updated_at = ?
    WHERE id = 1
  `).run(type, counterId, number, announcementText(number, counterId), timestamp, timestamp);
}

function emitState() {
  const state = getState();
  io.emit('state:update', state);
  return state;
}

function ok(res, extra = {}) {
  res.json({ ok: true, ...extra });
}

function fail(res, status, message) {
  res.status(status).json({ ok: false, error: message });
}

function asyncRoute(handler) {
  return (req, res) => {
    try {
      handler(req, res);
    } catch (error) {
      console.error(error);
      fail(res, 500, '伺服器處理失敗');
    }
  };
}

function requireAdmin(req, res, next) {
  const header = req.get('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (token !== ADMIN_TOKEN) return fail(res, 401, '未授權');
  next();
}

app.get('/api/state', asyncRoute((req, res) => {
  ok(res, { state: getState() });
}));

app.post('/api/tickets', asyncRoute((req, res) => {
  fail(res, 400, '本系統不提供線上取號，請依現場發放號碼牌為準');
}));

app.post('/api/admin/login', asyncRoute((req, res) => {
  if ((req.body && req.body.pin) === ADMIN_PIN) return ok(res, { token: ADMIN_TOKEN });
  fail(res, 401, 'PIN 錯誤');
}));

app.post('/api/admin/announce', requireAdmin, asyncRoute((req, res) => {
  io.emit('announce:prefix', {});
  ok(res);
}));

app.post('/api/admin/counters/:counterId/next', requireAdmin, asyncRoute((req, res) => {
  const counterId = parseCounterId(req.params.counterId);
  if (!counterId) return fail(res, 400, '櫃檯無效');

  const callNext = db.transaction(() => {
    const timestamp = now();
    const state = db.prepare('SELECT last_issued_number FROM system_state WHERE id = 1').get();
    const nextNumber = state.last_issued_number + 1;

    db.prepare(`
      UPDATE counters
      SET current_number = ?, updated_at = ?
      WHERE id = ?
    `).run(nextNumber, timestamp, counterId);
    db.prepare(`
      UPDATE system_state
      SET last_issued_number = ?
      WHERE id = 1
    `).run(nextNumber);
    setLastEvent('next', counterId, nextNumber, timestamp);
  });

  callNext();
  ok(res, { state: emitState() });
}));

app.post('/api/admin/counters/:counterId/recall', requireAdmin, asyncRoute((req, res) => {
  const counterId = parseCounterId(req.params.counterId);
  if (!counterId) return fail(res, 400, '櫃檯無效');

  const recall = db.transaction(() => {
    const counter = db.prepare('SELECT current_number FROM counters WHERE id = ?').get(counterId);
    if (!counter.current_number) return { error: '目前沒有可重叫的號碼' };

    const timestamp = now();
    setLastEvent('recall', counterId, counter.current_number, timestamp);
    db.prepare('UPDATE counters SET updated_at = ? WHERE id = ?').run(timestamp, counterId);
    return {};
  });

  const result = recall();
  if (result.error) return fail(res, 400, result.error);
  ok(res, { state: emitState() });
}));

app.post('/api/admin/counters/:counterId/jump', requireAdmin, asyncRoute((req, res) => {
  const counterId = parseCounterId(req.params.counterId);
  if (!counterId) return fail(res, 400, '櫃檯無效');

  const number = Number(req.body && req.body.number);
  if (!Number.isInteger(number) || number <= 0) {
    return fail(res, 400, '請輸入有效號碼');
  }

  const jumpCall = db.transaction(() => {
    const timestamp = now();
    const state = db.prepare('SELECT last_issued_number FROM system_state WHERE id = 1').get();
    const lastCalledNumber = Math.max(state.last_issued_number, number);

    db.prepare(`
      UPDATE counters
      SET current_number = ?, updated_at = ?
      WHERE id = ?
    `).run(number, timestamp, counterId);
    db.prepare(`
      UPDATE system_state
      SET last_issued_number = ?
      WHERE id = 1
    `).run(lastCalledNumber);
    setLastEvent('jump', counterId, number, timestamp);
  });

  jumpCall();
  ok(res, { state: emitState() });
}));

app.post('/api/admin/counters/:counterId/no-show', requireAdmin, asyncRoute((req, res) => {
  const counterId = parseCounterId(req.params.counterId);
  if (!counterId) return fail(res, 400, '櫃檯無效');

  const markNoShow = db.transaction(() => {
    const counter = db.prepare('SELECT current_number FROM counters WHERE id = ?').get(counterId);
    if (!counter.current_number) return { error: '目前沒有可標記未到的號碼' };

    const timestamp = now();
    db.prepare(`
      INSERT INTO tickets (number, status, created_at, called_at, updated_at, from_counter_id)
      VALUES (?, 'no_show', ?, NULL, ?, ?)
      ON CONFLICT(number) DO UPDATE SET
        status = 'no_show',
        from_counter_id = excluded.from_counter_id,
        updated_at = excluded.updated_at
    `).run(counter.current_number, timestamp, timestamp, counterId);
    db.prepare('UPDATE system_state SET updated_at = ? WHERE id = 1').run(timestamp);
    db.prepare('UPDATE counters SET updated_at = ? WHERE id = ?').run(timestamp, counterId);
    return {};
  });

  const result = markNoShow();
  if (result.error) return fail(res, 400, result.error);
  ok(res, { state: emitState() });
}));

app.post('/api/admin/no-show/:id/call', requireAdmin, asyncRoute((req, res) => {
  const id = Number(req.params.id);
  const counterId = parseCounterId(req.body && req.body.counterId);
  if (!Number.isInteger(id) || id <= 0) return fail(res, 400, '未到號碼 ID 無效');
  if (!counterId) return fail(res, 400, '櫃檯無效');

  const callNoShow = db.transaction(() => {
    const ticket = db.prepare('SELECT id, number FROM tickets WHERE id = ? AND status = ?').get(id, 'no_show');
    if (!ticket) return { error: '找不到未到號碼' };

    const timestamp = now();
    db.prepare(`
      UPDATE tickets
      SET status = 'called', called_at = ?, updated_at = ?
      WHERE id = ?
    `).run(timestamp, timestamp, id);
    db.prepare(`
      UPDATE counters
      SET recall_number = ?, updated_at = ?
      WHERE id = ?
    `).run(ticket.number, timestamp, counterId);
    setLastEvent('no_show_call', counterId, ticket.number, timestamp);
    return {};
  });

  const result = callNoShow();
  if (result.error) return fail(res, 404, result.error);
  ok(res, { state: emitState() });
}));

app.post('/api/admin/counters/:counterId/clear-recall', requireAdmin, asyncRoute((req, res) => {
  const counterId = parseCounterId(req.params.counterId);
  if (!counterId) return fail(res, 400, '櫃檯無效');

  const clearRecall = db.transaction(() => {
    const timestamp = now();
    db.prepare(`
      UPDATE counters
      SET recall_number = NULL, updated_at = ?
      WHERE id = ?
    `).run(timestamp, counterId);
    db.prepare('UPDATE system_state SET updated_at = ? WHERE id = 1').run(timestamp);
  });

  clearRecall();
  ok(res, { state: emitState() });
}));

app.post('/api/admin/reset', requireAdmin, asyncRoute((req, res) => {
  const reset = db.transaction(() => {
    const timestamp = now();
    db.prepare('DELETE FROM tickets').run();
    db.prepare(`
      UPDATE counters
      SET current_number = NULL, recall_number = NULL, updated_at = ?
    `).run(timestamp);
    db.prepare(`
      UPDATE system_state
      SET
        current_number = NULL,
        last_issued_number = 0,
        last_event_type = NULL,
        last_event_counter_id = NULL,
        last_event_number = NULL,
        last_event_announcement_text = NULL,
        last_event_timestamp = NULL,
        updated_at = ?
      WHERE id = 1
    `).run(timestamp);
  });

  reset();
  ok(res, { state: emitState() });
}));

io.on('connection', (socket) => {
  socket.emit('state:update', getState());
});

server.listen(PORT, HOST, () => {
  console.log(`Queue system listening on http://${HOST}:${PORT}`);
});
