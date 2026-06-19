import { io } from 'socket.io-client';

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
const ADMIN_PIN = process.env.ADMIN_PIN || '1234';
const CLIENT_COUNT = 50;
const TIMEOUT_MS = 8000;

function waitFor(predicate, timeoutMs, label) {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const timer = setInterval(() => {
      if (predicate()) {
        clearInterval(timer);
        resolve(Date.now() - startedAt);
        return;
      }
      if (Date.now() - startedAt > timeoutMs) {
        clearInterval(timer);
        reject(new Error(`Timeout waiting for ${label}`));
      }
    }, 20);
  });
}

async function request(path, options = {}) {
  const headers = {
    'Content-Type': 'application/json',
    ...(options.headers || {})
  };
  const response = await fetch(`${BASE_URL}${path}`, {
    ...options,
    headers
  });
  const contentType = response.headers.get('content-type') || '';
  const data = contentType.includes('application/json') ? await response.json() : await response.text();
  return { response, data };
}

async function expectJson(path, options = {}) {
  const { response, data } = await request(path, options);
  if (!data.ok) throw new Error(data.error || `${options.method || 'GET'} ${path} failed`);
  return data;
}

async function post(path, body, token) {
  return expectJson(path, {
    method: 'POST',
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    body: body ? JSON.stringify(body) : undefined
  });
}

function counter(state, id) {
  return state.counters.find((item) => item.id === id);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const clients = [];
const operationReceipts = new Map();
let connected = 0;
let adminToken = '';

function receiptKey(event) {
  return event && event.timestamp;
}

async function runOperation(label, operation, validate) {
  const startedAt = Date.now();
  const result = await operation();
  validate(result.state);

  const key = receiptKey(result.state.lastEvent);
  if (key) {
    await waitFor(
      () => (operationReceipts.get(key) || new Set()).size === CLIENT_COUNT,
      TIMEOUT_MS,
      `${label} state:update`
    );
  }

  return Date.now() - startedAt;
}

try {
  const publicPage = await request('/public.html');
  assert(publicPage.response.status === 200, 'Expected GET /public.html to return 200');

  const publicState = await expectJson('/api/state');
  assert(Array.isArray(publicState.state.counters), 'Expected public /api/state counters');

  const unauthorized = await request('/api/admin/counters/1/next', { method: 'POST' });
  assert(unauthorized.response.status === 401, 'Expected unauthorized admin operation to return 401');
  assert(unauthorized.data.error === '未授權', 'Expected unauthorized error message');

  const badLogin = await request('/api/admin/login', {
    method: 'POST',
    body: JSON.stringify({ pin: '0000' })
  });
  assert(badLogin.response.status === 401, 'Expected bad PIN to return 401');
  assert(badLogin.data.error === 'PIN 錯誤', 'Expected bad PIN error message');

  const login = await post('/api/admin/login', { pin: ADMIN_PIN });
  assert(typeof login.token === 'string' && login.token.length > 20, 'Expected admin token');
  adminToken = login.token;

  await post('/api/admin/reset', undefined, adminToken);

  for (let index = 0; index < CLIENT_COUNT; index += 1) {
    const socket = io(BASE_URL, {
      transports: ['websocket'],
      reconnection: false,
      timeout: TIMEOUT_MS
    });

    socket.on('connect', () => {
      connected += 1;
    });

    socket.on('state:update', (state) => {
      const key = receiptKey(state.lastEvent);
      if (!key) return;
      if (!operationReceipts.has(key)) operationReceipts.set(key, new Set());
      operationReceipts.get(key).add(index);
    });

    socket.on('connect_error', (error) => {
      console.error(`client ${index} connect_error: ${error.message}`);
    });

    clients.push(socket);
  }

  const connectMs = await waitFor(
    () => connected === CLIENT_COUNT,
    TIMEOUT_MS,
    `${CLIENT_COUNT} socket connections`
  );

  const durations = [];

  durations.push(await runOperation(
    'counter 1 next',
    () => post('/api/admin/counters/1/next', undefined, adminToken),
    (state) => {
      assert(counter(state, 1).currentNumber === 1, 'Expected counter 1 currentNumber 1');
      assert(state.lastEvent.announcementText === '1號請到1號櫃檯辦理', 'Unexpected counter 1 next announcement');
    }
  ));

  durations.push(await runOperation(
    'counter 2 next',
    () => post('/api/admin/counters/2/next', undefined, adminToken),
    (state) => {
      assert(counter(state, 2).currentNumber === 2, 'Expected counter 2 currentNumber 2');
      assert(state.lastEvent.announcementText === '2號請到2號櫃檯辦理', 'Unexpected counter 2 next announcement');
    }
  ));

  durations.push(await runOperation(
    'counter 1 jump 8',
    () => post('/api/admin/counters/1/jump', { number: 8 }, adminToken),
    (state) => {
      assert(counter(state, 1).currentNumber === 8, 'Expected counter 1 currentNumber 8');
      assert(state.lastEvent.announcementText === '8號請到1號櫃檯辦理', 'Unexpected jump announcement');
    }
  ));

  durations.push(await runOperation(
    'counter 2 recall',
    () => post('/api/admin/counters/2/recall', undefined, adminToken),
    (state) => {
      assert(counter(state, 2).currentNumber === 2, 'Expected counter 2 currentNumber to remain 2');
      assert(state.lastEvent.announcementText === '2號請到2號櫃檯辦理', 'Unexpected recall announcement');
    }
  ));

  await post('/api/admin/counters/1/no-show', undefined, adminToken);
  const afterNoShow = await expectJson('/api/state');
  const noShowTicket = afterNoShow.state.noShowList.find((ticket) => ticket.number === 8);
  assert(noShowTicket, 'Expected no-show ticket for number 8');
  assert(noShowTicket.fromCounterId === 1, 'Expected no-show from counter 1');

  durations.push(await runOperation(
    'call no-show to counter 2',
    () => post(`/api/admin/no-show/${noShowTicket.id}/call`, { counterId: 2 }, adminToken),
    (state) => {
      assert(counter(state, 2).currentNumber === 2, 'Counter 2 currentNumber was overwritten by no-show call');
      assert(counter(state, 2).recallNumber === 8, 'Expected counter 2 recallNumber 8');
      assert(!state.noShowList.some((ticket) => ticket.id === noShowTicket.id), 'No-show ticket was not removed');
      assert(state.lastEvent.announcementText === '8號請到2號櫃檯辦理', 'Unexpected no-show call announcement');
    }
  ));

  const averageMs = Math.round(durations.reduce((sum, ms) => sum + ms, 0) / durations.length);
  console.log(JSON.stringify({
    ok: true,
    clients: CLIENT_COUNT,
    connected,
    connectMs,
    operations: durations.length,
    operationDurationsMs: durations,
    averageBroadcastMs: averageMs
  }, null, 2));
} finally {
  clients.forEach((socket) => socket.disconnect());
}
