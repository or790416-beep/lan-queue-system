import { io } from 'socket.io-client';

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
const ADMIN_PIN = process.env.ADMIN_PIN || '1234';
const CLIENT_COUNT = Number(process.env.CLIENT_COUNT || 100);
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS || 10000);
const HOLD_MS = Number(process.env.HOLD_MS || 0);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

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

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

function percentile(values, pct) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((pct / 100) * sorted.length) - 1)];
}

const clients = [];
const connectedClients = new Set();
const disconnectedClients = new Set();
const clientErrors = [];
let activeOperation = null;

function recordBroadcast(index) {
  if (!activeOperation || activeOperation.receipts.has(index)) return;
  activeOperation.receipts.set(index, Date.now() - activeOperation.startedAt);
}

async function runOperation(label, operation, validate) {
  activeOperation = {
    label,
    startedAt: Date.now(),
    receipts: new Map()
  };

  const responseStartedAt = Date.now();
  const result = await operation();
  const responseMs = Date.now() - responseStartedAt;
  validate(result.state);

  await waitFor(
    () => activeOperation.receipts.size === CLIENT_COUNT,
    TIMEOUT_MS,
    `${label} state:update for ${CLIENT_COUNT} public clients`
  );

  const latencies = [...activeOperation.receipts.values()];
  const summary = {
    label,
    responseMs,
    received: activeOperation.receipts.size,
    averageBroadcastMs: Math.round(latencies.reduce((sum, ms) => sum + ms, 0) / latencies.length),
    maxBroadcastMs: Math.max(...latencies),
    p95BroadcastMs: percentile(latencies, 95)
  };
  activeOperation = null;
  return summary;
}

try {
  assert(Number.isInteger(CLIENT_COUNT) && CLIENT_COUNT > 0, 'CLIENT_COUNT must be a positive integer');

  const publicPage = await request('/public.html');
  assert(publicPage.response.status === 200, 'Expected GET /public.html to return 200');

  const publicState = await expectJson('/api/state');
  assert(Array.isArray(publicState.state.counters), 'Expected public /api/state counters');

  const login = await post('/api/admin/login', { pin: ADMIN_PIN });
  assert(typeof login.token === 'string' && login.token.length > 20, 'Expected admin token');
  const adminToken = login.token;

  await post('/api/admin/reset', undefined, adminToken);

  await Promise.all(Array.from({ length: CLIENT_COUNT }, async (_, index) => {
    const state = await expectJson('/api/state');
    assert(Array.isArray(state.state.counters), `client ${index} initial /api/state failed`);

    const socket = io(BASE_URL, {
      transports: ['websocket'],
      reconnection: false,
      timeout: TIMEOUT_MS
    });

    socket.on('connect', () => {
      connectedClients.add(index);
    });
    socket.on('disconnect', () => {
      disconnectedClients.add(index);
    });
    socket.on('connect_error', (error) => {
      clientErrors.push({ index, message: error.message });
    });
    socket.on('state:update', () => {
      recordBroadcast(index);
    });

    clients.push(socket);
  }));

  const connectMs = await waitFor(
    () => connectedClients.size === CLIENT_COUNT,
    TIMEOUT_MS,
    `${CLIENT_COUNT} public socket connections`
  );

  await delay(200);
  assert(disconnectedClients.size === 0, 'A public client disconnected before operations started');

  const operations = [];

  operations.push(await runOperation(
    'counter 1 next',
    () => post('/api/admin/counters/1/next', undefined, adminToken),
    (state) => {
      assert(counter(state, 1).currentNumber === 1, 'Expected counter 1 currentNumber 1');
    }
  ));

  operations.push(await runOperation(
    'counter 2 next',
    () => post('/api/admin/counters/2/next', undefined, adminToken),
    (state) => {
      assert(counter(state, 2).currentNumber === 2, 'Expected counter 2 currentNumber 2');
    }
  ));

  operations.push(await runOperation(
    'counter 1 next again',
    () => post('/api/admin/counters/1/next', undefined, adminToken),
    (state) => {
      assert(counter(state, 1).currentNumber === 3, 'Expected counter 1 currentNumber 3');
    }
  ));

  operations.push(await runOperation(
    'counter 1 jump 50',
    () => post('/api/admin/counters/1/jump', { number: 50 }, adminToken),
    (state) => {
      assert(counter(state, 1).currentNumber === 50, 'Expected counter 1 currentNumber 50');
    }
  ));

  operations.push(await runOperation(
    'counter 1 mark no-show',
    () => post('/api/admin/counters/1/no-show', undefined, adminToken),
    (state) => {
      assert(state.noShowList.some((ticket) => ticket.number === 50), 'Expected number 50 in noShowList');
    }
  ));

  const afterNoShow = await expectJson('/api/state');
  const noShowTicket = afterNoShow.state.noShowList.find((ticket) => ticket.number === 50);
  assert(noShowTicket, 'Expected no-show ticket for number 50');

  operations.push(await runOperation(
    'call no-show 50 to counter 2',
    () => post(`/api/admin/no-show/${noShowTicket.id}/call`, { counterId: 2 }, adminToken),
    (state) => {
      assert(counter(state, 2).recallNumber === 50, 'Expected counter 2 recallNumber 50');
    }
  ));

  operations.push(await runOperation(
    'counter 2 clear recall',
    () => post('/api/admin/counters/2/clear-recall', undefined, adminToken),
    (state) => {
      assert(counter(state, 2).currentNumber === null, 'Expected counter 2 currentNumber null after clear-recall');
      assert(counter(state, 2).recallNumber === null, 'Expected counter 2 recallNumber null after clear-recall');
    }
  ));

  if (HOLD_MS > 0) await delay(HOLD_MS);
  assert(disconnectedClients.size === 0, 'A public client disconnected during load test');

  const allLatencies = operations.flatMap((operation) => [
    operation.averageBroadcastMs,
    operation.maxBroadcastMs,
    operation.p95BroadcastMs
  ]);
  const averageBroadcastMs = Math.round(
    operations.reduce((sum, operation) => sum + operation.averageBroadcastMs, 0) / operations.length
  );
  const maxBroadcastMs = Math.max(...operations.map((operation) => operation.maxBroadcastMs));

  console.log(JSON.stringify({
    ok: true,
    baseUrl: BASE_URL,
    clients: CLIENT_COUNT,
    readonlyPublicClients: true,
    connected: connectedClients.size,
    disconnected: disconnectedClients.size,
    clientErrors,
    connectMs,
    operations,
    operationCount: operations.length,
    averageBroadcastMs,
    maxBroadcastMs,
    p95ObservedMs: percentile(allLatencies, 95)
  }, null, 2));
} finally {
  activeOperation = null;
  clients.forEach((socket) => socket.disconnect());
}
