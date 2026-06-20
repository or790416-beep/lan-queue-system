const socket = io();

const audio = { ctx: null, queue: [], playing: false, played: new Set() };
const SOUND_EVENTS = ['next', 'jump', 'recall', 'no_show_call'];
const CALLABLE_EVENTS = ['next', 'jump', 'recall', 'no_show_call'];
let hasInitialState = false;
let lastCall = null;

const els = {
  displayCounters: document.getElementById('displayCounters')
};

function eventKey(event) {
  if (!event) return null;
  return `${event.type}:${event.counterId}:${event.number}:${event.timestamp}`;
}

function getCtx() {
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (AudioContextClass && !audio.ctx) audio.ctx = new AudioContextClass();
  return audio.ctx;
}

function isUnlocked() {
  const ctx = getCtx();
  return Boolean(ctx && ctx.state === 'running');
}

function setupUnlock() {
  const overlay = document.getElementById('startOverlay');
  if (isUnlocked()) {
    if (overlay) overlay.hidden = true;
    return;
  }

  if (overlay) overlay.hidden = false;

  const unlock = async () => {
    const ctx = getCtx();
    if (ctx && ctx.state === 'suspended') {
      try {
        await ctx.resume();
      } catch (error) {
        // Autoplay policy failures are expected until the page receives a gesture.
      }
    }
    if (overlay) overlay.hidden = true;
    window.removeEventListener('pointerdown', unlock);
    window.removeEventListener('keydown', unlock);
  };

  window.addEventListener('pointerdown', unlock, { once: true });
  window.addEventListener('keydown', unlock, { once: true });
}

function enqueueAnnouncement(event, { silent = false } = {}) {
  if (!event) return;

  const key = eventKey(event);
  if (audio.played.has(key)) return;
  audio.played.add(key);
  if (silent) return;
  if (!SOUND_EVENTS.includes(event.type)) return;
  if (!isUnlocked()) return;

  audio.queue.push(`/audio/call-${event.number}-${event.counterId}.mp3`);
  playNext();
}

function playNext() {
  if (audio.playing || !audio.queue.length) return;

  audio.playing = true;
  const el = new Audio(audio.queue.shift());
  let finished = false;
  const done = () => {
    if (finished) return;
    finished = true;
    audio.playing = false;
    playNext();
  };

  el.addEventListener('ended', done);
  el.addEventListener('error', done);
  el.play().catch(done);
}

function playPrefixAnnouncement() {
  if (!isUnlocked()) return;

  audio.queue.push('/audio/prefix.mp3');
  if (lastCall) {
    audio.queue.push(`/audio/call-${lastCall.number}-${lastCall.counterId}.mp3`);
  }
  playNext();
}

async function loadState() {
  try {
    const response = await fetch('/api/state');
    const data = await response.json();
    if (data.ok) handleState(data.state);
  } catch (error) {
    console.error(error);
  }
}

function counterCard(counter, lastEvent) {
  const article = document.createElement('article');
  article.className = 'display-counter';

  const displayNumber = counter.recallNumber || counter.currentNumber || '--';
  const displayText = displayNumber === '--' ? '' : `${displayNumber}號請到${counter.id}號櫃檯辦理`;
  const activeText = lastEvent && lastEvent.counterId === counter.id ? lastEvent.announcementText : displayText;

  article.innerHTML = `
    <h2>${counter.id} 號櫃檯</h2>
    <div class="display-number-group">
      <span class="label">目前叫號</span>
      <strong class="display-number">${displayNumber}</strong>
      <span class="announcement-text">${activeText || ''}</span>
    </div>
  `;
  return article;
}

function render(state) {
  els.displayCounters.innerHTML = '';
  (state.counters || []).forEach((counter) => {
    els.displayCounters.appendChild(counterCard(counter, state.lastEvent));
  });
}

function handleState(state) {
  render(state);
  if (state.lastEvent && CALLABLE_EVENTS.includes(state.lastEvent.type)) {
    lastCall = state.lastEvent;
  } else if (!state.lastEvent || state.lastEvent.type === 'reset') {
    lastCall = null;
  }
  enqueueAnnouncement(state.lastEvent, { silent: !hasInitialState });
  hasInitialState = true;
}

setupUnlock();

socket.on('connect', loadState);
socket.io.on('reconnect', loadState);
socket.on('state:update', handleState);
socket.on('announce:prefix', playPrefixAnnouncement);

loadState();
