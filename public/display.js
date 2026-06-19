const socket = io();

let audioContext = null;
let lastEventKey = null;
let hasRenderedState = false;
const speechSupported = 'speechSynthesis' in window && 'SpeechSynthesisUtterance' in window;

const els = {
  displayCounters: document.getElementById('displayCounters')
};

function eventKey(event) {
  if (!event) return null;
  return `${event.type}:${event.counterId}:${event.number}:${event.timestamp}`;
}

function makeAudioContext() {
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) return null;
  if (!audioContext) audioContext = new AudioContextClass();
  return audioContext;
}

function playTone() {
  try {
    const context = makeAudioContext();
    if (!context) {
      console.warn('此瀏覽器不支援 Web Audio API 提示音');
      return;
    }

    const oscillator = context.createOscillator();
    const gain = context.createGain();
    const startedAt = context.currentTime;

    oscillator.type = 'sine';
    oscillator.frequency.setValueAtTime(880, startedAt);
    gain.gain.setValueAtTime(0.001, startedAt);
    gain.gain.exponentialRampToValueAtTime(0.25, startedAt + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.001, startedAt + 0.35);

    oscillator.connect(gain);
    gain.connect(context.destination);
    oscillator.start(startedAt);
    oscillator.stop(startedAt + 0.4);
  } catch (error) {
    console.warn('提示音播放失敗，可能受瀏覽器自動播放政策限制', error);
  }
}

function speakAnnouncement(text) {
  if (!text) return;

  try {
    if (speechSupported) {
      window.speechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.lang = 'zh-TW';
      utterance.rate = 0.95;
      window.speechSynthesis.speak(utterance);
      return;
    }

    playTone();
  } catch (error) {
    console.warn('語音播放失敗，已改用提示音', error);
    playTone();
  }
}

async function loadState() {
  try {
    const response = await fetch('/api/state');
    const data = await response.json();
    if (data.ok) render(data.state, false);
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

function render(state, shouldPlay = true) {
  els.displayCounters.innerHTML = '';
  (state.counters || []).forEach((counter) => {
    els.displayCounters.appendChild(counterCard(counter, state.lastEvent));
  });

  const key = eventKey(state.lastEvent);
  const isNewEvent = key && key !== lastEventKey;
  const canPlay = hasRenderedState && shouldPlay;

  if (isNewEvent && canPlay) {
    speakAnnouncement(state.lastEvent.announcementText);
  }

  if (key) lastEventKey = key;
  hasRenderedState = true;
}

try {
  makeAudioContext();
} catch (error) {
  console.warn('AudioContext 初始化失敗', error);
}

socket.on('connect', loadState);
socket.io.on('reconnect', loadState);
socket.on('state:update', (state) => render(state, true));

loadState();
