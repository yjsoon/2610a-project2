const STOP = '07371';              // Aft Kallang Rd, Lavender St — across from Aperia, towards Yio Chu Kang
const SERVICE = '13';
const API = 'https://arrivelah2.busrouter.sg/?id=' + STOP;
const RUN_SPEEDUP = 0.6;           // running covers the walk in 60% of the time
const LEAVE_WINDOW_MS = 2 * 60 * 1000;
const GONE_AFTER_MS = 45 * 1000;   // keep showing a bus briefly after its ETA passes
const GOING_MATCH_MS = 3 * 60 * 1000;
const STALE_AFTER_MS = 90 * 1000;
const POLL_MS = 15 * 1000;
const SIREN_EVERY_MS = 8 * 1000;
const TEST_MS = 6 * 1000;
const WALK_MIN = 1, WALK_MAX = 20, WALK_DEFAULT = 5;
const THEMES = ['auto', 'light', 'dark'];

const LOAD = { SEA: 'Seats available', SDA: 'Standing room', LSD: 'Nearly full' };
const TYPE = { SD: 'Single deck', DD: 'Double deck', BD: 'Bendy' };

const $ = id => document.getElementById(id);

function load(key, fallback) {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : v;
  } catch (e) {
    return fallback;
  }
}

function save(key, value) {
  try { localStorage.setItem(key, value); } catch (e) {}
}

let buses = [];
let lastOk = 0;
let failed = false;
let walkMin = Math.min(WALK_MAX, Math.max(WALK_MIN, parseInt(load('walkMin', WALK_DEFAULT), 10) || WALK_DEFAULT));
let soundWanted = load('sound', 'on') === 'on';
let audioCtx = null;
let wakeLock = null;
let goingAt = null;                // arrival time of the bus the user said they're heading for
let lastSiren = 0;
let lastBuzz = 0;
let lastState = '';
let testUntil = 0;

async function refresh() {
  try {
    const res = await fetch(API, { cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    const svc = (data.services || []).find(s => s.no === SERVICE);
    const seen = new Set();
    buses = [];
    for (const b of svc ? [svc.next, svc.subsequent, svc.next2, svc.next3] : []) {
      const at = b && b.time ? Date.parse(b.time) : NaN;
      if (isNaN(at) || seen.has(at)) continue;
      seen.add(at);
      buses.push({ at, load: b.load, type: b.type, live: !!b.monitored });
    }
    buses.sort((a, b) => a.at - b.at);
    // Estimates shift between polls, so follow the bus whose time is closest to the one acknowledged.
    if (goingAt !== null) {
      const near = buses.reduce((best, b) => !best || Math.abs(b.at - goingAt) < Math.abs(best.at - goingAt) ? b : best, null);
      goingAt = near && Math.abs(near.at - goingAt) <= GOING_MATCH_MS ? near.at : null;
    }
    lastOk = Date.now();
    failed = false;
  } catch (e) {
    failed = true;
  }
  render();
}

function clock(ms) {
  return new Date(ms).toLocaleTimeString('en-SG', { hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Singapore' });
}

function mmss(ms) {
  if (ms <= 0) return 'Now';
  const s = Math.floor(ms / 1000);
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}

function details(bus) {
  return [clock(bus.at), LOAD[bus.load], TYPE[bus.type], bus.live ? null : 'scheduled time'].filter(Boolean).join(' · ');
}

// Picks the bus to aim for and what to do about it, given how long the walk to the stop takes.
function decide(now) {
  const walkMs = walkMin * 60 * 1000;
  const stale = !lastOk || now - lastOk > STALE_AFTER_MS;
  const upcoming = buses.filter(b => b.at - now > -GONE_AFTER_MS);
  const going = goingAt === null ? undefined : upcoming.find(b => b.at === goingAt);
  const target = going || upcoming.find(b => b.at - now >= walkMs * RUN_SPEEDUP);
  const i = target ? upcoming.indexOf(target) : upcoming.length;
  const missed = going ? undefined : upcoming[i - 1];
  const after = upcoming[i + 1];
  const eta = target ? target.at - now : null;

  let state;
  if (now < testUntil) state = 'test';
  else if (!lastOk) state = failed ? 'error' : 'loading';
  else if (!target) state = 'none';
  else if (going) state = 'going';
  else if (stale) state = 'unsure';
  else if (eta < walkMs) state = 'run';
  else if (eta < walkMs + LEAVE_WINDOW_MS) state = 'leave';
  else state = 'wait';
  return { state, stale, target, missed, after, eta, walkMs };
}

function render() {
  const now = Date.now();
  const d = decide(now);
  const { state, stale, target, missed, after, eta } = d;
  if (goingAt !== null && state !== 'going' && state !== 'test') goingAt = null;
  const alarming = state === 'run' || state === 'test';
  document.body.dataset.state = alarming ? 'run' : state;

  const minsTo = bus => Math.max(1, Math.round((bus.at - now) / 60000));
  let verdict, sub;
  if (state === 'test') {
    verdict = 'RUN!';
    sub = 'This is a test of the alarm.';
  } else if (state === 'run') {
    verdict = 'RUN!';
    sub = after ? 'Miss it and the one after is in ' + minsTo(after) + ' min.' : 'You can only make this one by running.';
  } else if (state === 'leave') {
    verdict = 'Leave now';
    sub = 'Walk over now and you’ll make it without running.';
  } else if (state === 'wait') {
    verdict = 'No need to move yet';
    sub = 'Leave by ' + clock(target.at - d.walkMs) + ' to walk it.';
  } else if (state === 'going') {
    verdict = 'On your way';
    sub = 'Alarm silenced for this bus.';
  } else if (state === 'unsure') {
    verdict = 'Not sure';
    sub = 'Live times have stopped updating, so this may be wrong.';
  } else if (state === 'none') {
    verdict = missed ? 'Too late for this one' : 'No bus 13 right now';
    sub = missed
      ? 'No later bus is being reported yet.'
      : 'No arrival times are being reported. It may be outside service hours.';
  } else if (state === 'error') {
    verdict = 'No connection';
    sub = 'Can’t reach the bus arrivals service. Retrying…';
  }
  // Only touch the announced text when it changes, so screen readers aren't re-read every second.
  if (verdict && $('verdict').textContent !== verdict) $('verdict').textContent = verdict;
  if (sub && $('verdictSub').textContent !== sub) $('verdictSub').textContent = sub;

  $('targetLabel').textContent = missed && target ? 'Bus you can catch' : 'Next bus';
  $('countdown').textContent = target ? mmss(eta) : '–:––';
  $('nextMeta').textContent = target ? details(target) : '';
  $('missed').hidden = !missed;
  $('missed').textContent = missed ? 'The ' + clock(missed.at) + ' bus is too close to catch from ' + walkMin + ' min away.' : '';
  $('afterTime').textContent = after ? minsTo(after) + ' min' : '–';
  $('afterMeta').textContent = after ? details(after) : '';

  $('goBtn').hidden = !(alarming || state === 'leave' || state === 'going');
  $('goBtn').textContent = state === 'going' ? 'Not going after all' : 'I’m going';
  $('walkValue').textContent = walkMin + ' min';
  $('walkLess').disabled = walkMin <= WALK_MIN;
  $('walkMore').disabled = walkMin >= WALK_MAX;

  const armed = soundArmed();
  $('soundBtn').setAttribute('aria-pressed', String(soundWanted));
  $('soundBtn').textContent = !soundWanted ? 'Alarm sound is off' : armed ? 'Alarm sound is on' : 'Tap to arm alarm sound';

  if (!lastOk) {
    $('status').textContent = failed ? 'Offline. Retrying every 15 seconds.' : 'Connecting…';
    $('status').className = failed ? 'warn' : '';
  } else {
    $('status').textContent = (failed || stale ? 'Not updating. Last updated ' : 'Updated ') + clock(lastOk);
    $('status').className = failed || stale ? 'warn' : '';
  }
  $('awake').textContent = wakeLock
    ? 'Screen stays on while this page is open.'
    : 'Keep this page open and on screen, or the alarm can’t fire.';
  document.title = (alarming ? 'RUN! ' : '') + (target ? mmss(eta) + ' · ' : '') + 'Bus 13';

  // Timed separately so the siren starts the moment sound is unlocked, without re-triggering the buzz.
  if (alarming && now - lastSiren > SIREN_EVERY_MS && siren()) lastSiren = now;
  if (alarming && now - lastBuzz > SIREN_EVERY_MS) {
    lastBuzz = now;
    if (navigator.vibrate) navigator.vibrate([300, 150, 300, 150, 300]);
  }
  if (!alarming) lastSiren = lastBuzz = 0;
  if (state === 'leave' && lastState !== 'leave' && lastState !== 'run') chime();
  lastState = state;
}

function soundArmed() {
  return soundWanted && !!audioCtx && audioCtx.state === 'running';
}

// Browsers only allow sound after a tap, so this is retried on the first tap anywhere on the page.
function armSound() {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'running') return;
    audioCtx.resume().then(render, () => {});
  } catch (e) {}
}

function tone(build, seconds) {
  if (!soundArmed()) return false;
  const t = audioCtx.currentTime;
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  build(osc, t);
  gain.gain.setValueAtTime(0.0001, t);
  gain.gain.linearRampToValueAtTime(0.25, t + 0.05);
  gain.gain.setValueAtTime(0.25, t + seconds - 0.1);
  gain.gain.linearRampToValueAtTime(0.0001, t + seconds);
  osc.connect(gain).connect(audioCtx.destination);
  osc.start(t);
  osc.stop(t + seconds);
  return true;
}

function siren() {
  return tone((osc, t) => {
    osc.type = 'square';
    for (let i = 0; i < 4; i++) {
      osc.frequency.setValueAtTime(620, t + i * 0.5);
      osc.frequency.linearRampToValueAtTime(1150, t + i * 0.5 + 0.25);
      osc.frequency.linearRampToValueAtTime(620, t + i * 0.5 + 0.5);
    }
  }, 2);
}

// A single gentle two-note chime for "leave now", so the siren is kept for when running is needed.
function chime() {
  tone((osc, t) => {
    osc.type = 'sine';
    osc.frequency.setValueAtTime(660, t);
    osc.frequency.setValueAtTime(880, t + 0.25);
  }, 0.6);
}

// Stops the phone locking, which would pause the page and silence the alarm.
async function keepAwake() {
  if (!('wakeLock' in navigator) || document.hidden || wakeLock) return;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => { wakeLock = null; render(); });
  } catch (e) {
    wakeLock = null;
  }
  render();
}

function setWalk(minutes) {
  walkMin = Math.min(WALK_MAX, Math.max(WALK_MIN, minutes));
  save('walkMin', walkMin);
  render();
}

// 'auto' follows the system light/dark setting; the stylesheet does the rest from data-theme.
function setTheme(theme) {
  if (!THEMES.includes(theme)) theme = 'auto';
  if (theme === 'auto') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
  save('theme', theme);
  $('themeBtn').textContent = 'Theme: ' + theme[0].toUpperCase() + theme.slice(1);
  $('themeBtn').dataset.theme = theme;
}

$('themeBtn').addEventListener('click', e => {
  setTheme(THEMES[(THEMES.indexOf(e.currentTarget.dataset.theme) + 1) % THEMES.length]);
});

$('walkLess').addEventListener('click', () => setWalk(walkMin - 1));
$('walkMore').addEventListener('click', () => setWalk(walkMin + 1));

$('goBtn').addEventListener('click', () => {
  const d = decide(Date.now());
  if (d.state === 'test') testUntil = 0;
  else if (d.state === 'going') goingAt = null;
  else if (d.target) goingAt = d.target.at;
  render();
});

$('soundBtn').addEventListener('click', () => {
  // A tap while waiting to be armed should arm it, not switch it off.
  if (soundWanted && !soundArmed()) {
    armSound();
  } else {
    soundWanted = !soundWanted;
    save('sound', soundWanted ? 'on' : 'off');
    if (soundWanted) armSound();
  }
  render();
});

$('testBtn').addEventListener('click', () => {
  soundWanted = true;
  save('sound', 'on');
  armSound();
  testUntil = Date.now() + TEST_MS;
  lastSiren = lastBuzz = 0;
  render();
});

for (const type of ['pointerdown', 'keydown']) {
  document.addEventListener(type, e => {
    if (soundWanted && !soundArmed() && !(e.target.closest && e.target.closest('#soundBtn'))) armSound();
    keepAwake();
  });
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) return;
  refresh();
  keepAwake();
});

setTheme(load('theme', 'auto'));
if (soundWanted) armSound();
keepAwake();
refresh();
setInterval(refresh, POLL_MS);
setInterval(render, 1000);
