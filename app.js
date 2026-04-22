// ════════════════════════════════════════════════════════
//  Chess Coach AI — app.js
//  Full PWA logic: Chess.com polling + Claude analysis
// ════════════════════════════════════════════════════════

'use strict';

// ── State ────────────────────────────────────────────────
const state = {
  username: '',
  apiKey: '',
  games: [],
  selected: null,
  analysisCache: {},
  lastGameUrl: null,
  pollingInterval: null,
  polling: false,
  notifGranted: false,
};

// ── Settings persistence (Cache API as KV store) ─────────
async function saveSettings() {
  const c = await caches.open('chess-coach-settings');
  await c.put('/settings', new Response(JSON.stringify({
    username: state.username,
    apiKey: state.apiKey,
    lastGameUrl: state.lastGameUrl,
  }), { headers: { 'Content-Type': 'application/json' } }));
}

async function loadSettings() {
  try {
    const c = await caches.open('chess-coach-settings');
    const r = await c.match('/settings');
    if (!r) return;
    const d = await r.json();
    state.username = d.username || '';
    state.apiKey = d.apiKey || '';
    state.lastGameUrl = d.lastGameUrl || null;
  } catch (_) {}
}

// ── Analysis cache persistence ───────────────────────────
async function saveAnalysisCache() {
  const c = await caches.open('chess-coach-settings');
  await c.put('/analysis-cache', new Response(JSON.stringify(state.analysisCache), {
    headers: { 'Content-Type': 'application/json' }
  }));
}

async function loadAnalysisCache() {
  try {
    const c = await caches.open('chess-coach-settings');
    const r = await c.match('/analysis-cache');
    if (!r) return;
    state.analysisCache = await r.json();
  } catch (_) {}
}

// ── Chess.com API ────────────────────────────────────────
async function fetchGames(username) {
  const now = new Date();
  const months = [
    { y: now.getFullYear(), m: now.getMonth() + 1 },
    { y: now.getMonth() === 0 ? now.getFullYear() - 1 : now.getFullYear(),
      m: now.getMonth() === 0 ? 12 : now.getMonth() },
  ];
  let all = [];
  for (const { y, m } of months) {
    const mm = String(m).padStart(2, '0');
    try {
      const res = await fetch(`https://api.chess.com/pub/player/${username}/games/${y}/${mm}`, {
        headers: { 'User-Agent': 'ChessCoachPWA/1.0' }
      });
      if (!res.ok) continue;
      const data = await res.json();
      const games = (data.games || []).reverse().map(g => parseGame(g, username));
      all = [...all, ...games];
    } catch (_) {}
    if (all.length >= 25) break;
  }
  return all.slice(0, 25);
}

function parseGame(g, username) {
  const pgn = g.pgn || '';
  const get = tag => { const m = pgn.match(new RegExp(`\\[${tag} "([^"]+)"\\]`)); return m ? m[1] : '?'; };
  const tcSecs = parseInt((g.time_control || '0').split('+')[0]);
  let timeClass = '?';
  if (tcSecs < 180) timeClass = 'Bullet';
  else if (tcSecs < 600) timeClass = 'Blitz';
  else if (tcSecs < 1800) timeClass = 'Rapid';
  else timeClass = 'Classical';
  const white = g.white?.username || get('White');
  const black = g.black?.username || get('Black');
  const result = get('Result');
  const u = username.toLowerCase();
  const isWhite = white.toLowerCase() === u;
  let outcome = 'draw';
  if ((result === '1-0' && isWhite) || (result === '0-1' && !isWhite)) outcome = 'win';
  else if ((result === '0-1' && isWhite) || (result === '1-0' && !isWhite)) outcome = 'loss';
  return {
    id: g.url,
    url: g.url,
    pgn, white, black, result, outcome, timeClass,
    eco: get('ECO'),
    date: get('Date').replace(/\./g, '/'),
    whiteElo: g.white?.rating || get('WhiteElo'),
    blackElo: g.black?.rating || get('BlackElo'),
    termination: get('Termination'),
    isWhite,
    myElo: isWhite ? (g.white?.rating || get('WhiteElo')) : (g.black?.rating || get('BlackElo')),
    oppElo: isWhite ? (g.black?.rating || get('BlackElo')) : (g.white?.rating || get('WhiteElo')),
    opponent: isWhite ? black : white,
    timeControl: g.time_control,
  };
}

// ── Claude API ───────────────────────────────────────────
async function analyzeGame(game) {
  if (state.analysisCache[game.id]) return state.analysisCache[game.id];

  const side = game.isWhite ? 'White' : 'Black';
  const prompt = `You are a world-class chess coach. Analyze this game by "${state.username}" playing as ${side} against "${game.opponent}" (${game.myElo} vs ${game.oppElo} rated).

PGN:
${game.pgn}

Return ONLY a JSON object with this exact structure (no markdown, no preamble):
{
  "summary": "2-3 sentence game story",
  "overall_grade": "B+",
  "phase_analysis": {
    "opening": {"grade": "B", "comment": "..."},
    "middlegame": {"grade": "C", "comment": "..."},
    "endgame": {"grade": "A", "comment": "..."}
  },
  "key_moments": [
    {
      "move_number": 14,
      "move_played": "Nxf7",
      "better_move": "Nd5",
      "type": "blunder",
      "explanation": "...",
      "concept": "Tactical concept"
    }
  ],
  "patterns": ["Pattern observed 1", "Pattern 2"],
  "lessons": [
    {"title": "Lesson title", "detail": "What to study and why"}
  ],
  "strengths": ["Good thing 1"],
  "weaknesses": ["Area to improve 1"],
  "coach_message": "Personal motivating message to the player"
}

Include 3-6 key moments. Be specific about move numbers. Use types: blunder, mistake, inaccuracy, missed_tactic, good_move, brilliant.`;

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${state.apiKey}`,
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      max_tokens: 1000,
      messages: [{ role: 'user', content: prompt }],
    })
  });
  const data = await res.json();
  const text = data.choices?.[0]?.message?.content || '';
  const clean = text.replace(/```json|```/g, '').trim();
  const analysis = JSON.parse(clean);
  state.analysisCache[game.id] = analysis;
  await saveAnalysisCache();
  return analysis;
}

// ── Polling ──────────────────────────────────────────────
function startPolling() {
  if (state.pollingInterval) return;
  state.pollingInterval = setInterval(pollNow, 30000); // every 30s
  // Also try Periodic Background Sync
  registerPeriodicSync();
}

function stopPolling() {
  clearInterval(state.pollingInterval);
  state.pollingInterval = null;
}

async function pollNow() {
  if (!state.username || state.polling) return;
  state.polling = true;
  updatePollingDot(true);
  try {
    const games = await fetchGames(state.username);
    if (!games.length) return;
    const latest = games[0];
    if (latest.id !== state.lastGameUrl) {
      state.lastGameUrl = latest.id;
      state.games = games;
      await saveSettings();
      renderGameList();
      showNewGameBanner(latest);
    }
  } catch (_) {} finally {
    state.polling = false;
    updatePollingDot(false);
  }
}

async function registerPeriodicSync() {
  try {
    const reg = await navigator.serviceWorker.ready;
    if ('periodicSync' in reg) {
      await reg.periodicSync.register('poll-chess-games', { minInterval: 60000 });
    }
  } catch (_) {}
}

// ── Notifications ────────────────────────────────────────
async function requestNotifications() {
  if (!('Notification' in window)) return false;
  const p = await Notification.requestPermission();
  state.notifGranted = p === 'granted';
  return state.notifGranted;
}

// ── Service Worker comms ─────────────────────────────────
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('message', e => {
    if (e.data?.type === 'NEW_GAME') {
      const game = parseGame(e.data.game, state.username);
      state.games.unshift(game);
      renderGameList();
      showNewGameBanner(game);
    }
    if (e.data?.type === 'OPEN_LATEST' && state.games[0]) {
      selectGame(state.games[0]);
    }
  });
}

// ════════════════════════════════════════════════════════
//  UI RENDERING
// ════════════════════════════════════════════════════════

function $(id) { return document.getElementById(id); }

function showNewGameBanner(game) {
  const banner = $('new-game-banner');
  const msg = $('banner-msg');
  msg.textContent = `New game finished! vs ${game.opponent} — tap to analyze`;
  banner.style.display = 'flex';
  banner.onclick = () => { banner.style.display = 'none'; selectGame(game); };
  setTimeout(() => { banner.style.display = 'none'; }, 12000);
}

function updatePollingDot(active) {
  const dot = $('poll-dot');
  if (!dot) return;
  dot.style.background = active ? '#facc15' : '#4ade80';
  dot.title = active ? 'Checking for new games…' : 'Watching for new games';
}

function renderGameList() {
  const list = $('game-list');
  if (!list) return;
  if (!state.games.length) {
    list.innerHTML = `<div class="empty-state">No games found.<br>Make sure your profile is public.</div>`;
    return;
  }
  list.innerHTML = state.games.map((g, i) => {
    const outcomeColor = g.outcome === 'win' ? '#4ade80' : g.outcome === 'loss' ? '#f87171' : '#8a8a9a';
    const outcomeLabel = g.outcome === 'win' ? 'W' : g.outcome === 'loss' ? 'L' : 'D';
    const cached = state.analysisCache[g.id];
    const grade = cached?.overall_grade || '';
    const isSelected = state.selected?.id === g.id;
    return `<div class="game-row ${isSelected ? 'active' : ''}" data-idx="${i}" onclick="selectGame(state.games[${i}])">
      <div class="game-row-left">
        <div class="outcome-badge" style="background:${outcomeColor}22;color:${outcomeColor};border-color:${outcomeColor}44">${outcomeLabel}</div>
        <div>
          <div class="game-opp">vs ${g.opponent}</div>
          <div class="game-meta">${g.timeClass} · ${g.eco !== '?' ? g.eco : 'Game'} · ${g.date}</div>
        </div>
      </div>
      <div class="game-row-right">
        ${grade ? `<div class="grade-chip">${grade}</div>` : ''}
        <div class="elo-diff">${g.myElo}</div>
      </div>
    </div>`;
  }).join('');
}

async function selectGame(game) {
  state.selected = game;
  renderGameList();
  showScreen('analysis');
  renderAnalysisShell(game);
  // auto-analyze
  await runAnalysis(game);
}

function renderAnalysisShell(game) {
  const panel = $('analysis-panel');
  const outcomeColor = game.outcome === 'win' ? '#4ade80' : game.outcome === 'loss' ? '#f87171' : '#8a8a9a';
  const outcomeLabel = game.outcome === 'win' ? 'Win' : game.outcome === 'loss' ? 'Loss' : 'Draw';
  panel.innerHTML = `
    <div class="analysis-header">
      <button class="back-btn" onclick="showScreen('games')">← Games</button>
      <div class="game-title">
        <span class="game-title-main">${game.white} vs ${game.black}</span>
        <span class="game-title-sub">${game.timeClass} · You played ${game.isWhite ? 'White' : 'Black'} · <span style="color:${outcomeColor}">${outcomeLabel}</span></span>
      </div>
    </div>
    <div id="analysis-content" class="analysis-content">
      <div class="loading-state">
        <div class="spinner">♟</div>
        <div class="loading-text">Claude is analyzing your game…</div>
        <div class="loading-sub">Reviewing every move, finding mistakes & building your lessons</div>
        <div class="loading-dots"><span></span><span></span><span></span></div>
      </div>
    </div>`;
}

async function runAnalysis(game) {
  const content = $('analysis-content');
  try {
    const a = await analyzeGame(game);
    renderAnalysisResult(game, a);
  } catch (err) {
    content.innerHTML = `<div class="error-state">
      <div style="font-size:32px;margin-bottom:12px">⚠️</div>
      <div>Analysis failed. Check your API key in Settings.</div>
      <button class="retry-btn" onclick="runAnalysis(state.selected)">Retry</button>
    </div>`;
  }
}

function renderAnalysisResult(game, a) {
  const gradeColors = { A: '#4ade80', B: '#a3e635', C: '#facc15', D: '#fb923c', F: '#f87171' };
  const gc = g => gradeColors[g?.[0]] || '#aaa';

  const typeMap = {
    blunder: { icon: '💣', label: 'Blunder', color: '#f87171' },
    mistake: { icon: '⚠️', label: 'Mistake', color: '#fb923c' },
    inaccuracy: { icon: '〽️', label: 'Inaccuracy', color: '#facc15' },
    missed_tactic: { icon: '🎯', label: 'Missed Tactic', color: '#a78bfa' },
    good_move: { icon: '✓', label: 'Good Move', color: '#4ade80' },
    brilliant: { icon: '✨', label: 'Brilliant!', color: '#67e8f9' },
  };

  const content = $('analysis-content');
  content.innerHTML = `
    <!-- Grade hero -->
    <div class="grade-hero">
      <div class="overall-grade" style="color:${gc(a.overall_grade)};border-color:${gc(a.overall_grade)}44">
        ${a.overall_grade}
      </div>
      <div class="summary-text">${a.summary}</div>
    </div>

    <!-- Phase grades -->
    <div class="phase-grid">
      ${Object.entries(a.phase_analysis || {}).map(([phase, d]) => `
        <div class="phase-card">
          <div class="phase-top">
            <span class="phase-name">${phase}</span>
            <span class="phase-grade" style="color:${gc(d.grade)}">${d.grade}</span>
          </div>
          <div class="phase-comment">${d.comment}</div>
        </div>
      `).join('')}
    </div>

    <!-- Tabs -->
    <div class="tab-bar">
      <button class="tab-btn active" onclick="switchTab('moments', this)">Key Moments</button>
      <button class="tab-btn" onclick="switchTab('lessons', this)">Lessons</button>
      <button class="tab-btn" onclick="switchTab('verdict', this)">Verdict</button>
    </div>

    <!-- Moments tab -->
    <div id="tab-moments" class="tab-content active">
      ${(a.key_moments || []).map(m => {
        const t = typeMap[m.type] || { icon: '◆', label: m.type, color: '#aaa' };
        return `<div class="moment-card">
          <div class="moment-top">
            <span class="move-num">Move ${m.move_number}</span>
            <span class="type-badge" style="color:${t.color};border-color:${t.color}33;background:${t.color}10">${t.icon} ${t.label}</span>
            ${m.concept ? `<span class="concept-tag">${m.concept}</span>` : ''}
          </div>
          <div class="move-pair">
            <div class="move-box played">
              <div class="move-box-label">Played</div>
              <div class="move-box-move">${m.move_played}</div>
            </div>
            <div class="move-arrow">→</div>
            <div class="move-box better">
              <div class="move-box-label">Better</div>
              <div class="move-box-move">${m.better_move}</div>
            </div>
          </div>
          <div class="moment-explanation">${m.explanation}</div>
        </div>`;
      }).join('')}
    </div>

    <!-- Lessons tab -->
    <div id="tab-lessons" class="tab-content">
      ${(a.patterns || []).length > 0 ? `
        <div class="patterns-section">
          <div class="section-label">PATTERNS OBSERVED</div>
          <div class="pattern-chips">
            ${a.patterns.map(p => `<span class="pattern-chip">${p}</span>`).join('')}
          </div>
        </div>` : ''}
      ${(a.lessons || []).map(l => `
        <div class="lesson-card">
          <div class="lesson-title">📚 ${l.title}</div>
          <div class="lesson-detail">${l.detail}</div>
        </div>`).join('')}
    </div>

    <!-- Verdict tab -->
    <div id="tab-verdict" class="tab-content">
      <div class="verdict-grid">
        <div class="verdict-col strengths">
          <div class="verdict-label">✓ STRENGTHS</div>
          ${(a.strengths || []).map(s => `<div class="verdict-item">· ${s}</div>`).join('')}
        </div>
        <div class="verdict-col weaknesses">
          <div class="verdict-label">△ WORK ON</div>
          ${(a.weaknesses || []).map(w => `<div class="verdict-item">· ${w}</div>`).join('')}
        </div>
      </div>
      <div class="coach-message">
        <div class="coach-label">♟ COACH SAYS</div>
        <div class="coach-text">"${a.coach_message}"</div>
      </div>
    </div>`;
}

function switchTab(name, btn) {
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
  btn.classList.add('active');
  $(`tab-${name}`).classList.add('active');
}

function showScreen(name) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  $(`screen-${name}`).classList.add('active');
  // Update bottom nav
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
  const navBtn = $(`nav-${name}`);
  if (navBtn) navBtn.classList.add('active');
}

// ── Setup screen ─────────────────────────────────────────
function renderSetupScreen() {
  $('setup-username').value = state.username;
  $('setup-apikey').value = state.apiKey;
}

async function saveSetup() {
  const u = $('setup-username').value.trim();
  const k = $('setup-apikey').value.trim();
  if (!u) { alert('Please enter your Chess.com username'); return; }
  state.username = u;
  state.apiKey = k;
  await saveSettings();
  $('setup-status').textContent = '✓ Saved!';
  $('setup-status').style.color = '#4ade80';
  setTimeout(() => { $('setup-status').textContent = ''; }, 2000);
  // Load games
  await loadAndRender();
}

async function loadAndRender() {
  if (!state.username) return;
  $('games-status').textContent = 'Loading…';
  try {
    state.games = await fetchGames(state.username);
    state.lastGameUrl = state.games[0]?.id || null;
    await saveSettings();
    renderGameList();
    $('games-status').textContent = `${state.games.length} games · @${state.username}`;
    startPolling();
  } catch (_) {
    $('games-status').textContent = 'Failed to load games';
  }
}

async function requestNotifAndStart() {
  const granted = await requestNotifications();
  $('notif-btn').textContent = granted ? '🔔 Notifications enabled!' : '🔕 Permission denied';
  $('notif-btn').disabled = true;
}

// ── Boot ─────────────────────────────────────────────────
async function boot() {
  // Register SW
  if ('serviceWorker' in navigator) {
    try {
      await navigator.serviceWorker.register('sw.js');
    } catch (_) {}
  }

  await loadSettings();
  await loadAnalysisCache();

  renderSetupScreen();

  if (state.username) {
    showScreen('games');
    await loadAndRender();
  } else {
    showScreen('settings');
  }

  // Check notification permission
  if (Notification.permission === 'granted') {
    state.notifGranted = true;
    $('notif-btn').textContent = '🔔 Notifications enabled!';
    $('notif-btn').disabled = true;
  }

  // Handle SW messages
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('message', e => {
      if (e.data?.type === 'NEW_GAME') {
        const game = parseGame(e.data.game, state.username);
        if (!state.games.find(g => g.id === game.id)) {
          state.games.unshift(game);
          renderGameList();
          showNewGameBanner(game);
        }
      }
    });
  }
}

// Expose to global
window.state = state;
window.selectGame = selectGame;
window.switchTab = switchTab;
window.showScreen = showScreen;
window.saveSetup = saveSetup;
window.pollNow = pollNow;
window.requestNotifAndStart = requestNotifAndStart;

document.addEventListener('DOMContentLoaded', boot);
