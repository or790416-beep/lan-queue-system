const socket = io();

const TOKEN_KEY = 'adminToken';
let currentState = null;
let adminToken = sessionStorage.getItem(TOKEN_KEY) || '';

const els = {
  connectionStatus: document.getElementById('connectionStatus'),
  loginPanel: document.getElementById('loginPanel'),
  loginForm: document.getElementById('loginForm'),
  pinInput: document.getElementById('pinInput'),
  loginMessage: document.getElementById('loginMessage'),
  adminContent: document.getElementById('adminContent'),
  logoutBtn: document.getElementById('logoutBtn'),
  announceBtn: document.getElementById('announceBtn'),
  counterPanels: document.getElementById('counterPanels'),
  noShowList: document.getElementById('noShowList'),
  message: document.getElementById('message'),
  resetBtn: document.getElementById('resetBtn')
};

function isAuthenticated() {
  return Boolean(adminToken);
}

function setLoginMessage(text) {
  els.loginMessage.textContent = text || '';
}

function showMessage(text, isError = false) {
  els.message.textContent = text || '';
  els.message.classList.toggle('error', isError);
}

function showLogin() {
  adminToken = '';
  sessionStorage.removeItem(TOKEN_KEY);
  currentState = null;
  els.loginPanel.hidden = false;
  els.adminContent.hidden = true;
  els.counterPanels.innerHTML = '';
  els.noShowList.innerHTML = '';
  showMessage('');
  els.pinInput.value = '';
  els.pinInput.focus();
}

function showAdmin() {
  els.loginPanel.hidden = true;
  els.adminContent.hidden = false;
  setLoginMessage('');
  loadState();
}

function authHeaders(url) {
  if (!url.startsWith('/api/admin/') || url === '/api/admin/login') return {};
  return adminToken ? { Authorization: `Bearer ${adminToken}` } : {};
}

async function requestJson(url, options = {}) {
  const headers = {
    'Content-Type': 'application/json',
    ...authHeaders(url),
    ...(options.headers || {})
  };
  const response = await fetch(url, {
    ...options,
    headers
  });
  const data = await response.json();
  if (!data.ok) {
    if (response.status === 401 && url !== '/api/admin/login') showLogin();
    throw new Error(data.error || '操作失敗');
  }
  if (data.state && isAuthenticated()) render(data.state);
  return data;
}

async function login(pin) {
  const data = await requestJson('/api/admin/login', {
    method: 'POST',
    body: JSON.stringify({ pin })
  });
  adminToken = data.token;
  sessionStorage.setItem(TOKEN_KEY, adminToken);
  showAdmin();
}

async function loadState() {
  if (!isAuthenticated()) return;
  try {
    const data = await requestJson('/api/state');
    render(data.state);
  } catch (error) {
    showMessage(error.message, true);
  }
}

async function postAction(url, body) {
  if (!isAuthenticated()) {
    showLogin();
    return;
  }

  try {
    await requestJson(url, {
      method: 'POST',
      body: body ? JSON.stringify(body) : undefined
    });
    showMessage('操作完成');
  } catch (error) {
    showMessage(error.message, true);
  }
}

function counterPanel(counter) {
  const section = document.createElement('section');
  section.className = 'panel counter-panel';

  const title = document.createElement('h2');
  title.textContent = counter.name;

  const numbers = document.createElement('div');
  numbers.className = 'summary-grid';
  numbers.innerHTML = `
    <div>
      <span class="label">目前叫號</span>
      <strong class="number">${counter.currentNumber || '--'}</strong>
    </div>
    <div>
      <span class="label">過號叫號</span>
      <strong class="number">${counter.recallNumber || '--'}</strong>
    </div>
  `;

  const actions = document.createElement('div');
  actions.className = 'actions';

  const nextBtn = document.createElement('button');
  nextBtn.textContent = '順號';
  nextBtn.addEventListener('click', () => postAction(`/api/admin/counters/${counter.id}/next`));

  const recallBtn = document.createElement('button');
  recallBtn.textContent = '重叫目前號碼';
  recallBtn.addEventListener('click', () => postAction(`/api/admin/counters/${counter.id}/recall`));

  const noShowBtn = document.createElement('button');
  noShowBtn.textContent = '標記目前號碼未到';
  noShowBtn.addEventListener('click', () => postAction(`/api/admin/counters/${counter.id}/no-show`));

  const clearRecallBtn = document.createElement('button');
  clearRecallBtn.textContent = '清除過號';
  clearRecallBtn.addEventListener('click', () => postAction(`/api/admin/counters/${counter.id}/clear-recall`));

  actions.append(nextBtn, recallBtn, noShowBtn, clearRecallBtn);

  const jumpForm = document.createElement('form');
  jumpForm.className = 'inline-form';
  jumpForm.innerHTML = `
    <input type="number" min="1" placeholder="指定號碼" aria-label="${counter.name}跳號號碼">
    <button type="submit">跳號</button>
  `;
  jumpForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const input = jumpForm.querySelector('input');
    postAction(`/api/admin/counters/${counter.id}/jump`, { number: Number(input.value) });
  });

  section.append(title, numbers, actions, jumpForm);
  return section;
}

function renderNoShowList(list) {
  els.noShowList.innerHTML = '';
  if (!list.length) {
    els.noShowList.innerHTML = '<li>目前沒有未到號碼</li>';
    return;
  }
  list.forEach((ticket) => {
    const item = document.createElement('li');
    const label = document.createElement('span');
    const actions = document.createElement('span');

    label.textContent = `號碼 ${ticket.number}（原 ${ticket.fromCounterId || '--'} 號櫃檯）`;
    actions.className = 'list-actions';

    (currentState.counters || []).forEach((counter) => {
      const callBtn = document.createElement('button');
      callBtn.textContent = `過號叫到 ${counter.id} 號櫃檯`;
      callBtn.addEventListener('click', () => {
        postAction(`/api/admin/no-show/${ticket.id}/call`, { counterId: counter.id });
      });
      actions.append(callBtn);
    });

    item.append(label, actions);
    els.noShowList.appendChild(item);
  });
}

function render(state) {
  if (!isAuthenticated()) return;
  currentState = state;
  els.counterPanels.innerHTML = '';
  (state.counters || []).forEach((counter) => {
    els.counterPanels.appendChild(counterPanel(counter));
  });
  renderNoShowList(state.noShowList || []);
}

els.loginForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  setLoginMessage('');
  try {
    await login(els.pinInput.value);
  } catch (error) {
    setLoginMessage(error.message || 'PIN 錯誤，請重新輸入');
  }
});

els.logoutBtn.addEventListener('click', showLogin);

els.announceBtn.addEventListener('click', () => {
  postAction('/api/admin/announce');
});

els.resetBtn.addEventListener('click', () => {
  if (confirm('確定要重設今日號碼？此操作會清空目前號碼資料。')) {
    postAction('/api/admin/reset');
  }
});

socket.on('connect', () => {
  els.connectionStatus.textContent = '已連線';
  if (isAuthenticated()) loadState();
});

socket.on('disconnect', () => {
  els.connectionStatus.textContent = '連線中斷';
});

socket.io.on('reconnect', loadState);
socket.on('state:update', render);

if (isAuthenticated()) {
  showAdmin();
} else {
  showLogin();
}
