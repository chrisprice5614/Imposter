const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const APP_NAME = process.env.APP_NAME || 'Imposter';
const PORT = process.env.PORT || 2026;

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const fs = require('fs');

// EJS setup
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Static files
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.urlencoded({ extended: true }));

// In-memory room storage
const rooms = new Map();
const MAX_PLAYERS = 20;
const MIN_TO_START = 3;
const COLORS = [
  '#ff3b3b', '#4a90e2', '#50e3c2', '#f5a623', '#9013fe',
  '#b8e986', '#f8e71c', '#7ed321', '#d0021b', '#8b572a',
  '#bd10e0', '#417505', '#f6a', '#0bd', '#ff7f50',
  '#1abc9c', '#e74c3c', '#3498db', '#9b59b6', '#e67e22'
];

// Load prompts
const PROMPTS = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'prompts.json'), 'utf-8'));
const SUBJECTS = Object.keys(PROMPTS);

function sanitizeUpperLetters(str) {
  if (!str || typeof str !== 'string') return '';
  return str.toUpperCase().replace(/[^A-Z]/g, '');
}

function pickColor(used = new Set()) {
  for (const c of COLORS) {
    if (!used.has(c)) return c;
  }
  return COLORS[Math.floor(Math.random() * COLORS.length)];
}

function generateRoomCode() {
  // 4-letter uppercase code A-Z
  let code = '';
  do {
    code = Array.from({ length: 4 }, () => String.fromCharCode(65 + Math.floor(Math.random() * 26))).join('');
  } while (rooms.has(code));
  return code;
}

function getRoom(code) {
  return rooms.get(code);
}
function stopPhaseTimer(room) {
  const g = room.game;
  if (!g) return;
  if (g.phaseTimer) {
    clearInterval(g.phaseTimer);
    g.phaseTimer = null;
  }
}

function startPhaseTimer(room, seconds, onExpire) {
  const g = room.game;
  if (!g) return;
  stopPhaseTimer(room);
  g.timerSecondsLeft = seconds;
  io.to(room.code).emit('phaseTimer', { phase: g.phase, secondsLeft: g.timerSecondsLeft });
  g.phaseTimer = setInterval(() => {
    // If phase changed externally, stop timer
    if (!g || g.phaseTimer === null) return;
    g.timerSecondsLeft -= 1;
    if (g.timerSecondsLeft > 0) {
      io.to(room.code).emit('phaseTimer', { phase: g.phase, secondsLeft: g.timerSecondsLeft });
    } else {
      stopPhaseTimer(room);
      try { if (typeof onExpire === 'function') onExpire(); } catch (e) {}
    }
  }, 1000);
}

function setRoom(code, data) {
  rooms.set(code, data);
}

function removeFromRoom(room, socketId) {
  if (!room) return;
  const idx = room.players.findIndex(p => p.id === socketId);
  if (idx !== -1) {
    room.players.splice(idx, 1);
  }
  if (room.hostId === socketId) {
    const newHost = room.players[0];
    room.hostId = newHost ? newHost.id : null;
    if (newHost) {
      const p = room.players.find(pl => pl.id === newHost.id);
      if (p) p.isHost = true;
    }
  }
}

app.get('/', (req, res) => {
  res.render('index', { appName: APP_NAME });
});

io.on('connection', (socket) => {
  let currentRoomCode = null;
  let currentName = null;

  socket.on('createRoom', ({ name }) => {
    const cleanName = sanitizeUpperLetters(name).slice(0, 20);
    if (!cleanName) {
      socket.emit('errorMessage', 'Name required (letters A-Z only).');
      return;
    }
    const code = generateRoomCode();
    const room = {
      code,
      players: [],
      hostId: socket.id,
      started: false,
      countdown: null,
      game: null
    };
    const usedColors = new Set();
    const color = pickColor(usedColors);
    room.players.push({ id: socket.id, name: cleanName, color, isHost: true, score: 0, connected: true });
    setRoom(code, room);
    socket.join(code);
    currentRoomCode = code;
    currentName = cleanName;
    // Send only safe data to avoid circular references
    const safePlayers = room.players.map(p => ({ id: p.id, name: p.name, color: p.color }));
    socket.emit('roomCreated', { code, players: safePlayers, hostId: room.hostId, youName: cleanName });
    io.to(code).emit('playersUpdate', { players: room.players, hostId: room.hostId });
  });

  socket.on('joinRoom', ({ name, code }) => {
    const cleanName = sanitizeUpperLetters(name).slice(0, 20);
    const cleanCode = sanitizeUpperLetters(code).slice(0, 4);
    if (!cleanName) {
      socket.emit('errorMessage', 'Name required (letters A-Z only).');
      return;
    }
    if (!rooms.has(cleanCode)) {
      socket.emit('errorMessage', 'Room not found.');
      return;
    }
    const room = getRoom(cleanCode);
    // Rejoin support even before game starts: if name exists but is disconnected, allow reconnection
    const existingPlayer = room.players.find(p => p.name === cleanName);
    if (existingPlayer && !existingPlayer.connected) {
      existingPlayer.id = socket.id;
      existingPlayer.connected = true;
      socket.join(cleanCode);
      currentRoomCode = cleanCode;
      currentName = cleanName;
      // If no current host (e.g., everyone disconnected), restore host to this player if they were host before
      if (!room.hostId && existingPlayer.isHost) {
        room.hostId = existingPlayer.id;
      }
      const safePlayers = room.players.map(p => ({ id: p.id, name: p.name, color: p.color }));
      socket.emit('roomJoined', { code: cleanCode, players: safePlayers, hostId: room.hostId, youName: cleanName });
      io.to(cleanCode).emit('playersUpdate', { players: room.players, hostId: room.hostId });
      // Sync game state if ongoing
      if (room.game) {
        socket.emit('gameState', serializeGameState(room));
        sendPhaseStateToPlayer(room, existingPlayer);
      }
      return;
    }
    if (room.started) {
      // Allow rejoin only if name exists and is disconnected
      const existing = room.players.find(p => p.name === cleanName);
      if (!existing) {
        socket.emit('errorMessage', 'Game already started.');
        return;
      }
      if (existing.connected) {
        socket.emit('errorMessage', 'Player name already in use.');
        return;
      }
      existing.id = socket.id;
      existing.connected = true;
      socket.join(cleanCode);
      currentRoomCode = cleanCode;
      currentName = cleanName;
      const safePlayers2 = room.players.map(p => ({ id: p.id, name: p.name, color: p.color }));
      socket.emit('roomJoined', { code: cleanCode, players: safePlayers2, hostId: room.hostId, youName: cleanName });
      io.to(cleanCode).emit('playersUpdate', { players: room.players, hostId: room.hostId });
      // Sync game state if ongoing
      if (room.game) {
        socket.emit('gameState', serializeGameState(room));
        sendPhaseStateToPlayer(room, existing);
      }
      return;
    }
    if (room.players.length >= MAX_PLAYERS) {
      socket.emit('errorMessage', 'Room is full (max 20).');
      return;
    }
    // prevent duplicate names in room
    if (room.players.some(p => p.name === cleanName)) {
      socket.emit('errorMessage', 'Name already taken in this room.');
      return;
    }
    const usedColors = new Set(room.players.map(p => p.color));
    const color = pickColor(usedColors);
    room.players.push({ id: socket.id, name: cleanName, color, isHost: false, score: 0, connected: true });
    setRoom(cleanCode, room);
    socket.join(cleanCode);
    currentRoomCode = cleanCode;
    currentName = cleanName;
    const safePlayers3 = room.players.map(p => ({ id: p.id, name: p.name, color: p.color }));
    socket.emit('roomJoined', { code: cleanCode, players: safePlayers3, hostId: room.hostId, youName: cleanName });
    io.to(cleanCode).emit('playersUpdate', { players: room.players, hostId: room.hostId });
  });

  socket.on('startGame', () => {
    const code = currentRoomCode;
    const room = getRoom(code);
    if (!room) return;
    if (room.hostId !== socket.id) {
      socket.emit('errorMessage', 'Only host can start.');
      return;
    }
    if (room.players.length < MIN_TO_START) {
      socket.emit('errorMessage', 'Need at least 3 players.');
      return;
    }
    if (room.countdown) return; // already counting

    let count = 3;
    io.to(code).emit('countdown', count);
    room.countdown = setInterval(() => {
      count -= 1;
      if (count > 0) {
        io.to(code).emit('countdown', count);
      } else {
        clearInterval(room.countdown);
        room.countdown = null;
        room.started = true;
        startNewGame(room);
      }
    }, 1000);
  });

  socket.on('cancelStart', () => {
    const code = currentRoomCode;
    const room = getRoom(code);
    if (!room) return;
    if (room.hostId !== socket.id) {
      socket.emit('errorMessage', 'Only host can cancel.');
      return;
    }
    if (room.countdown) {
      clearInterval(room.countdown);
      room.countdown = null;
      io.to(code).emit('countdownCanceled');
    }
  });

  // Gameplay events
  socket.on('chooseSubject', (subject) => {
    const room = getRoom(currentRoomCode);
    if (!room || !room.game) return;
    const g = room.game;
    if (g.phase !== 'choose' || g.chooserId !== socket.id) return;
    if (!SUBJECTS.includes(subject)) return;
    setSubjectAndPrompt(room, subject);
  });

  socket.on('doneTalk', () => {
    const room = getRoom(currentRoomCode);
    const g = room.game;
    if (g.phase !== 'talk') return;
    const currentSpeaker = g.talkOrder[g.talkIndex];
    if (currentSpeaker !== currentName) return;
    advanceTalk(room);
  });

  socket.on('voteFor', (targetName) => {
    const room = getRoom(currentRoomCode);
    if (!room || !room.game) return;
    const g = room.game;
    if (g.phase !== 'vote') return;
    const voter = room.players.find(p => p.name === currentName);
    if (!voter || voter.name === g.imposterName) {
      // Imposter or invalid cannot vote
      return;
    }
    if (voter.hasVotedThisRound) {
      return;
    }
    const target = room.players.find(p => p.name === sanitizeUpperLetters(targetName));
    if (!target) return;
      io.to(voter.id).emit('phaseVoteAlready', { message: 'You voted, waiting on others.' });
    g.votes.push({ voter: voter.name, target: target.name, round: g.voteRound });
    voter.hasVotedThisRound = true;
    io.to(room.code).emit('voteUpdate', { votes: g.votes, votedBy: voter.name });
    checkVoteProgress(room);
  });

  socket.on('goAroundAgain', () => {
    const room = getRoom(currentRoomCode);
    if (!room || !room.game) return;
    const g = room.game;
    if (g.phase !== 'vote') return;
    if (g.voteRound >= 3) return; // must vote in round 3
    const player = room.players.find(p => p.name === currentName);
    if (!player || player.name === g.imposterName) return;
    if (!player.hasVotedThisRound) {
      player.clickedGoAgainThisRound = true;
      io.to(player.id).emit('phaseVoteWaiting', { message: 'Waiting on others.' });
    }
    // Only switch to talk when ALL non-imposters have either voted or clicked go-again
    if (allNonImpostersActioned(room)) {
      g.phase = 'talk';
      room.players.forEach(p => { p.clickedGoAgainThisRound = false; });
      g.talkIndex = 0;
      emitTalkState(room);
    }
  });

  socket.on('disconnect', () => {
    const code = currentRoomCode;
    const room = getRoom(code);
    if (!room) return;
    const player = room.players.find(p => p.id === socket.id);
    if (player) {
      player.connected = false;
    }
    // If host disconnected, reassign to first connected player
    if (room.hostId === socket.id) {
      const newHost = room.players.find(p => p.connected);
      room.hostId = newHost ? newHost.id : null;
      if (newHost) {
        room.players.forEach(p => { p.isHost = (p.id === newHost.id); });
      }
    }
    io.to(code).emit('playersUpdate', { players: room.players, hostId: room.hostId });
    if (!room.players.some(p => p.connected)) {
      rooms.delete(code);
    }
  });
});

// ==== Game helpers ====
function serializeGameState(room) {
  const g = room.game;
  if (!g) return null;
  return {
    round: g.round,
    phase: g.phase,
    subject: g.subject || null,
    chooser: g.chooserName || null,
    imposter: g.imposterName || null,
    talkOrder: g.talkOrder,
    talkIndex: g.talkIndex,
    voteRound: g.voteRound,
    votes: g.votes
  };
}

function sendPhaseStateToPlayer(room, player) {
  const g = room.game;
  if (!g || !player) return;
  const sendTimer = () => {
    if (typeof g.timerSecondsLeft === 'number' && g.timerSecondsLeft > 0) {
      io.to(player.id).emit('phaseTimer', { phase: g.phase, secondsLeft: g.timerSecondsLeft });
    }
  };
  if (g.phase === 'choose') {
    io.to(player.id).emit('phaseChoose', { chooser: g.chooserName, subjects: SUBJECTS });
    sendTimer();
    return;
  }
  if (g.phase === 'talk') {
    const speakerName = g.talkOrder[g.talkIndex];
    if (player.name === speakerName) {
      const msg = (player.name === g.imposterName) ? 'You are the imposter, blend in.' : 'Say something related to the prompt';
      io.to(player.id).emit('phaseTalkYou', { message: msg, prompt: (player.name === g.imposterName) ? null : g.prompt, you: player.name });
    } else {
      io.to(player.id).emit('phaseTalkOther', {
        speaker: speakerName,
        prompt: (player.name !== g.imposterName) ? g.prompt : null,
        youAreImposter: (player.name === g.imposterName)
      });
    }
    sendTimer();
    return;
  }
  if (g.phase === 'vote') {
    const candidates = room.players.map(p => p.name);
    if (player.name === g.imposterName) {
      io.to(player.id).emit('phaseVoteImposter', { message: 'Look like you\'re voting' });
    } else if (player.hasVotedThisRound) {
      io.to(player.id).emit('phaseVoteAlready', { message: 'You already voted, please wait' });
    } else {
      io.to(player.id).emit('phaseVote', { candidates, voteRound: g.voteRound, canGoAround: g.voteRound < 3 });
    }
    sendTimer();
    return;
  }
  if (g.phase === 'score') {
    io.to(player.id).emit('phaseScoreReveal', { imposter: g.imposterName });
    return;
  }
}

function startNewGame(room) {
  room.game = { round: 1 };
  startRound(room);
}

function startRound(room) {
  const g = room.game;
  const active = room.players.filter(p => p.connected);
  const names = active.map(p => p.name);
  // Pick imposter randomly
  g.imposterName = names[Math.floor(Math.random() * names.length)];
  // Pick chooser randomly
  g.chooserName = names[Math.floor(Math.random() * names.length)];
  g.chooserId = active.find(p => p.name === g.chooserName)?.id || null;
  g.phase = 'choose';
  g.subject = null;
  g.prompt = null;
  g.countdownTimer = null;
  g.votes = [];
  g.voteRound = 0;
  room.players.forEach(p => { p.hasVotedThisRound = false; p.clickedGoAgainThisRound = false; });
  io.to(room.code).emit('phaseChoose', { chooser: g.chooserName, subjects: SUBJECTS });
  // 10-second timer to auto choose & broadcast countdown
  startPhaseTimer(room, 10, () => {
    if (g.phase === 'choose' && !g.subject) {
      const randomSubject = SUBJECTS[Math.floor(Math.random() * SUBJECTS.length)];
      setSubjectAndPrompt(room, randomSubject);
    }
  });
}

function setSubjectAndPrompt(room, subject) {
  const g = room.game;
  if (!g) return;
  stopPhaseTimer(room);
  g.subject = subject;
  const list = PROMPTS[subject] || [];
  const prompt = list[Math.floor(Math.random() * list.length)] || 'Mystery Prompt';
  g.prompt = prompt;
  // Setup talk order starting at random player
  const active = room.players.filter(p => p.connected);
  const order = shuffle(active.map(p => p.name));
  const startIndex = Math.floor(Math.random() * order.length);
  const rotated = order.slice(startIndex).concat(order.slice(0, startIndex));
  g.talkOrder = rotated;
  g.talkStartIndex = 0;
  g.talkStartName = rotated[0];
  g.talkIndex = 0;
  g.phase = 'talk';
  io.to(room.code).emit('phaseChosen', { subject, promptChooser: g.chooserName });
  emitTalkState(room);
}

function emitTalkState(room) {
  const g = room.game;
  const speakerName = g.talkOrder[g.talkIndex];
  // Start per-turn 10s timer; auto advance if no action
  stopPhaseTimer(room);
  startPhaseTimer(room, 10, () => {
    if (g.phase === 'talk') advanceTalk(room);
  });
  room.players.forEach(p => {
    if (p.name === speakerName) {
      const msg = (p.name === g.imposterName) ? 'You are the imposter, blend in.' : 'Say something related to the prompt';
      io.to(p.id).emit('phaseTalkYou', { message: msg, prompt: (p.name === g.imposterName) ? null : g.prompt, you: p.name });
    } else {
      // Show prompt to everyone except the imposter; inform imposter of their role
      io.to(p.id).emit('phaseTalkOther', {
        speaker: speakerName,
        prompt: (p.name !== g.imposterName) ? g.prompt : null,
        youAreImposter: (p.name === g.imposterName)
      });
    }
  });
}

function advanceTalk(room) {
  const g = room.game;
  g.talkIndex += 1;
  if (g.talkIndex >= g.talkOrder.length) {
    // Move to vote
    g.phase = 'vote';
    g.voteRound += 1;
    emitVoteState(room);
  } else {
    emitTalkState(room);
  }
}

function emitVoteState(room) {
  const g = room.game;
  const candidates = room.players.map(p => p.name);
  // Start 10s vote timer; if expires, auto go-around or score
  stopPhaseTimer(room);
  startPhaseTimer(room, 10, () => {
    if (g.phase !== 'vote') return;
    if (g.voteRound < 3 && !allNonImpostersVoted(room)) {
      g.phase = 'talk';
      room.players.forEach(p => { p.clickedGoAgainThisRound = false; });
      g.talkIndex = 0;
      emitTalkState(room);
    } else {
      startScorePhase(room);
    }
  });
  room.players.forEach(p => {
    if (p.name === g.imposterName) {
      io.to(p.id).emit('phaseVoteImposter', { message: 'Look like you\'re voting' });
    } else if (p.hasVotedThisRound) {
      io.to(p.id).emit('phaseVoteAlready', { message: 'You already voted, please wait' });
    } else {
      io.to(p.id).emit('phaseVote', { candidates, voteRound: g.voteRound, canGoAround: g.voteRound < 3 });
    }
  });
}

function allNonImpostersVoted(room) {
  const g = room.game;
  return room.players.filter(p => p.name !== g.imposterName).every(p => p.hasVotedThisRound);
}

function allNonImpostersActioned(room) {
  const g = room.game;
  return room.players
    .filter(p => p.name !== g.imposterName)
    .every(p => p.hasVotedThisRound || p.clickedGoAgainThisRound);
}

function checkVoteProgress(room) {
  const g = room.game;
  if (allNonImpostersVoted(room)) {
    stopPhaseTimer(room);
    startScorePhase(room);
    return;
  }
  // If everyone has taken an action (voted or clicked go-again) and it's not round 3, return to talk
  if (allNonImpostersActioned(room) && g.voteRound < 3) {
    stopPhaseTimer(room);
    g.phase = 'talk';
    room.players.forEach(p => { p.clickedGoAgainThisRound = false; });
    g.talkIndex = 0;
    emitTalkState(room);
    return;
  }
  // In round 3, force remaining voters to see vote UI (no go-again)
  if (g.voteRound >= 3) {
    emitVoteState(room);
  }
}

function startScorePhase(room) {
  const g = room.game;
  stopPhaseTimer(room);
  g.phase = 'score';
  // Reveal imposter fun
  io.to(room.code).emit('phaseScoreReveal', { imposter: g.imposterName });
  // Calculate points for normal players
  const voteByPlayer = new Map();
  for (const v of g.votes) {
    if (!voteByPlayer.has(v.voter)) {
      voteByPlayer.set(v.voter, v);
    }
  }
  const nonImpostersCount = room.players.length - 1;
  let correctVotes = 0;
  room.players.forEach(p => {
    if (p.name === g.imposterName) return;
    const v = voteByPlayer.get(p.name);
    let pts = 0;
    if (v && v.target === g.imposterName) {
      correctVotes += 1;
      if (v.round === 1) pts = 900;
      else if (v.round === 2) pts = 600;
      else pts = 300;
    }
    // schedule per-player display and score update
    const idx = room.players.findIndex(pp => pp.name === p.name);
    setTimeout(() => {
      io.to(room.code).emit('phaseScorePlayer', { player: p.name, votedFor: v ? v.target : null, points: pts });
      p.score += pts;
    }, 1000 + 3000 * idx);
  });
  // Imposter scoring after others
  const imposter = room.players.find(p => p.name === g.imposterName);
  const perCorrect = nonImpostersCount > 0 ? Math.floor(900 / nonImpostersCount) : 0;
  let impPts = 900 - perCorrect * correctVotes;
  if (impPts < 0) impPts = 0;
  setTimeout(() => {
    io.to(room.code).emit('phaseScoreImposter', { imposter: imposter.name, correctVotes, points: impPts });
    imposter.score += impPts;
  }, 1000 + 3000 * room.players.length);
  // Show scoreboard, then next round or end
  setTimeout(() => {
    const scoreboard = room.players.map(p => ({ name: p.name, score: p.score }));
    const sorted = scoreboard.slice().sort((a,b)=>b.score-a.score).map((row, idx) => ({ ...row, place: idx + 1 }));
    io.to(room.code).emit('phaseScoreBoard', { scoreboard: sorted });
  }, 1000 + 3000 * room.players.length + 6000);
  setTimeout(() => {
    // Next round or end game
    if (g.round < 3) {
      g.round += 1;
      startRound(room);
    } else {
      endGame(room);
    }
  }, 1000 + 3000 * room.players.length + 12000);
}

function endGame(room) {
  const scoreboard = room.players.map(p => ({ name: p.name, score: p.score })).sort((a,b)=>b.score-a.score);
  const winner = scoreboard[0] || null;
  io.to(room.code).emit('gameEnded', { scoreboard, winner });
  // Return to lobby state
  room.started = false;
  room.game = null;
  room.players.forEach(p => { p.hasVotedThisRound = false; });
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
function expandPromptsTo(base, subject, target) {
  const set = new Set(base);
  const arr = base.slice();
  const suffixMap = {
    'Celebrities': ['Interview', 'Concert', 'Tour', 'Album', 'Song', 'Award', 'Red Carpet', 'Scandal', 'Fan Theory', 'Biography'],
    'Movies/TV Shows': ['Sequel', 'Prequel', 'Spin-off', 'Trailer', 'Director', 'Cast', 'Soundtrack', 'Episode', 'Season', 'Reboot'],
    'Sports': ['Final', 'Championship', 'Playoffs', 'MVP', 'Record', 'Highlight', 'Draft', 'Coach', 'Team', 'League'],
    'Music': ['Album', 'Song', 'Tour', 'Concert', 'Playlist', 'Remix', 'Cover', 'Duet', 'Collab', 'Grammy'],
    'Historical Events': ['Timeline', 'Documentary', 'Leader', 'Battle', 'Treaty', 'Reform', 'Legacy', 'Archive', 'Memorial', 'Anniversary'],
    'Personal Life': ['Story', 'Memory', 'Moment', 'Lesson', 'Goal', 'Plan', 'Milestone', 'Dream', 'Challenge', 'Achievement']
  };
  const suffixes = suffixMap[subject] || ['Topic'];
  let idx = 0;
  if (arr.length === 0) arr.push(subject);
  while (arr.length < target) {
    const baseItem = arr[idx % arr.length];
    const suf = suffixes[idx % suffixes.length];
    const candidate = `${baseItem} ${suf}`;
    if (!set.has(candidate)) {
      set.add(candidate);
      arr.push(candidate);
    }
    idx++;
  }
  return arr;
}
server.listen(PORT, () => {
  console.log(`${APP_NAME} server running on port ${PORT}`);
});
