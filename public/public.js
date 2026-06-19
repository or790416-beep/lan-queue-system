const socket = io();

const els = {
  publicCounters: document.getElementById('publicCounters')
};

async function loadState() {
  try {
    const response = await fetch('/api/state');
    const data = await response.json();
    if (data.ok) render(data.state);
  } catch (error) {
    console.error(error);
  }
}

function counterCard(counter) {
  const article = document.createElement('article');
  article.className = 'public-counter';

  const displayNumber = counter.recallNumber || counter.currentNumber || '--';
  const displayText = displayNumber === '--' ? '' : `${displayNumber}號請到${counter.id}號櫃檯辦理`;

  article.innerHTML = `
    <h3>${counter.id} 號櫃檯</h3>
    <strong class="public-number">${displayNumber}</strong>
    <span>${displayText}</span>
  `;
  return article;
}

function render(state) {
  els.publicCounters.innerHTML = '';
  (state.counters || []).forEach((counter) => {
    els.publicCounters.appendChild(counterCard(counter));
  });
}

socket.on('connect', loadState);
socket.io.on('reconnect', loadState);
socket.on('state:update', render);

loadState();
