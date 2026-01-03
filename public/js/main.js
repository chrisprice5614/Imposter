/* Client-side logic for Imposter */
(function () {
  const socket = io();

  // Prevent pull-to-refresh on mobile while keeping normal scroll
  (function disablePullToRefresh() {
    let touchStartY = 0;
    let maybePrevent = false;
    window.addEventListener('touchstart', (e) => {
      if (e.touches && e.touches.length === 1) {
        touchStartY = e.touches[0].clientY;
        // Only consider preventing if we are scrolled to the very top
        maybePrevent = window.pageYOffset === 0;
      }
    }, { passive: false });
    window.addEventListener('touchmove', (e) => {
      if (!maybePrevent || !(e.touches && e.touches.length === 1)) return;
      const touchY = e.touches[0].clientY;
      const deltaY = touchY - touchStartY;
      touchStartY = touchY;
      // If pulling down from the top, prevent default to stop refresh
      if (deltaY > 0) {
        e.preventDefault();
      }
    }, { passive: false });
  })();

  const screenHome = document.getElementById('screen-home');
  const screenLobby = document.getElementById('screen-lobby');
  const screenGame = document.getElementById('screen-game');

  const nameInput = document.getElementById('nameInput');
  const codeInput = document.getElementById('codeInput');
  const createBtn = document.getElementById('createBtn');
  const joinBtn = document.getElementById('joinBtn');
  const startBtn = document.getElementById('startBtn');
  const cancelBtn = document.getElementById('cancelBtn');

  const errorBox = document.getElementById('error');
  const roomCodeBox = document.getElementById('roomCode');
  const youNameBox = document.getElementById('youName');
  const playersList = document.getElementById('playersList');
  const countdownEl = document.getElementById('countdown');
  // Game screen elements
  const gameMessage = document.getElementById('gameMessage');
  const choosePhase = document.getElementById('choosePhase');
  const subjectsEl = document.getElementById('subjects');
  const talkPhase = document.getElementById('talkPhase');
  const promptBox = document.getElementById('promptBox');
  const yourTurnBox = document.getElementById('yourTurnBox');
  const doneTalkBtn = document.getElementById('doneTalkBtn');
  const votePhase = document.getElementById('votePhase');
  const candidatesEl = document.getElementById('candidates');
  const goAgainBtn = document.getElementById('goAgainBtn');
  const voteNote = document.getElementById('voteNote');
  const scorePhase = document.getElementById('scorePhase');
  const revealEl = document.getElementById('reveal');
  const scoreStream = document.getElementById('scoreStream');
  const scoreBoard = document.getElementById('scoreBoard');
  const phaseTimerEl = document.getElementById('phaseTimer');
  const gameRoomCodeEl = document.getElementById('gameRoomCode');
  // Modal
  const connModal = document.getElementById('connModal');
  const connModalMsg = document.getElementById('connModalMsg');
  const connModalBtn = document.getElementById('connModalBtn');

  let currentRoomCode = null;
  let isHost = false;
  let youName = '';

  function showScreen(screen) {
    [screenHome, screenLobby, screenGame].forEach(s => s.classList.add('hidden'));
    screen.classList.remove('hidden');
  }

  function toUpperLetters(el) {
    const val = el.value.toUpperCase().replace(/[^A-Z]/g, '');
    el.value = val;
  }

  if (nameInput) nameInput.addEventListener('input', () => toUpperLetters(nameInput));
  if (codeInput) codeInput.addEventListener('input', () => {
    toUpperLetters(codeInput);
    if (codeInput.value.length > 4) {
      codeInput.value = codeInput.value.slice(0, 4);
    }
  });

  function setError(msg) {
    errorBox.textContent = msg || '';
  }

  function renderPlayers(players, hostId) {
    playersList.innerHTML = '';
    players.forEach(p => {
      const li = document.createElement('li');
      li.textContent = p.name + (p.id === hostId ? ' (HOST)' : '');
      li.style.color = p.color;
      li.style.fontWeight = '700';
      playersList.appendChild(li);
    });
    // host control visibility
    startBtn.classList.toggle('hidden', !isHost);
    startBtn.disabled = !(players.length >= 3) || !isHost;
  }

  if (createBtn) createBtn.addEventListener('click', () => {
    setError('');
    const name = nameInput.value.trim();
    socket.emit('createRoom', { name });
  });

  if (joinBtn) joinBtn.addEventListener('click', () => {
    setError('');
    const name = nameInput.value.trim();
    const code = codeInput.value.trim();
    socket.emit('joinRoom', { name, code });
  });

  if (startBtn) startBtn.addEventListener('click', () => {
    socket.emit('startGame');
    cancelBtn.classList.remove('hidden');
  });

  if (cancelBtn) cancelBtn.addEventListener('click', () => {
    socket.emit('cancelStart');
  });

  // No explicit leave; players will close the site

  // Socket handlers
  socket.on('errorMessage', (msg) => setError(msg));
  // Connection and closure handlers
  socket.on('disconnect', (reason) => {
    showConnectionModal('Disconnected from server. Please try again.');
    bootToMenu();
  });
  socket.on('connect_error', (err) => {
    showConnectionModal('Connection error. Please refresh and try again.');
    bootToMenu();
  });
  socket.on('roomClosed', (msg) => {
    showConnectionModal(msg || 'Room has been closed.');
    bootToMenu();
  });

  if (connModalBtn) {
    connModalBtn.addEventListener('click', () => {
      hideConnectionModal();
    });
  }

  function showConnectionModal(message) {
    connModalMsg.textContent = message;
    connModal.classList.remove('hidden');
  }
  function hideConnectionModal() {
    connModal.classList.add('hidden');
  }
  function bootToMenu() {
    currentRoomCode = null;
    isHost = false;
    youName = '';
    playersList.innerHTML = '';
    roomCodeBox.textContent = '';
    youNameBox.textContent = '';
    countdownEl.classList.add('hidden');
    cancelBtn.classList.add('hidden');
    showScreen(screenHome);
  }

  socket.on('roomCreated', ({ code, players, hostId, youName: you }) => {
    youName = you || '';
    isHost = true;
    currentRoomCode = code;
    roomCodeBox.textContent = code;
    youNameBox.textContent = youName;
    renderPlayers(players, hostId);
    if (gameRoomCodeEl) gameRoomCodeEl.textContent = code;
    showScreen(screenLobby);
  });

  socket.on('roomJoined', ({ code, players, hostId, youName: you }) => {
    youName = you || '';
    isHost = hostId === socket.id; // likely false
    currentRoomCode = code;
    roomCodeBox.textContent = code;
    youNameBox.textContent = youName;
    renderPlayers(players, hostId);
    if (gameRoomCodeEl) gameRoomCodeEl.textContent = code;
    showScreen(screenLobby);
  });

  socket.on('playersUpdate', ({ players, hostId }) => {
    isHost = hostId === socket.id;
    renderPlayers(players, hostId);
  });

  socket.on('countdown', (n) => {
    countdownEl.textContent = String(n);
    countdownEl.classList.remove('hidden');
  });

  socket.on('countdownCanceled', () => {
    countdownEl.classList.add('hidden');
    cancelBtn.classList.add('hidden');
  });

  // Phases
  socket.on('phaseChoose', ({ chooser, subjects }) => {
    showScreen(screenGame);
    showPhase('choose');
    gameMessage.textContent = (youName === chooser) ? 'Choose a subject' : `${chooser} is choosing a subject`;
    subjectsEl.innerHTML = '';
    if (phaseTimerEl) {
      if (youName === chooser) {
        phaseTimerEl.classList.remove('hidden');
      } else {
        phaseTimerEl.classList.add('hidden');
        phaseTimerEl.textContent = '';
      }
    }
    // Render subjects for everyone; only chooser can click
    subjects.forEach(s => {
      const btn = document.createElement('button');
      btn.className = 'btn btn-secondary';
      btn.textContent = s;
      if (youName === chooser) {
        btn.addEventListener('click', () => socket.emit('chooseSubject', s));
      } else {
        btn.disabled = true;
      }
      subjectsEl.appendChild(btn);
    });
    if (gameRoomCodeEl) gameRoomCodeEl.textContent = currentRoomCode || '';
  });

  socket.on('phaseChosen', ({ subject, promptChooser }) => {
    gameMessage.textContent = `${promptChooser} chose ${subject}`;
  });

  socket.on('phaseTalkYou', ({ message, prompt, you }) => {
    showPhase('talk');
    gameMessage.textContent = '';
    promptBox.textContent = prompt ? `Prompt: ${prompt}` : 'You are the imposter, blend in.';
    // Clear, centered instruction for the player
    yourTurnBox.textContent = 'Say something related to the prompt';
    doneTalkBtn.classList.remove('hidden');
    if (phaseTimerEl) phaseTimerEl.classList.remove('hidden');
    if (gameRoomCodeEl) gameRoomCodeEl.textContent = currentRoomCode || '';
  });

  socket.on('phaseTalkOther', ({ speaker, prompt, youAreImposter }) => {
    showPhase('talk');
    gameMessage.textContent = `${speaker} is saying something about the prompt.`;
    if (youAreImposter) {
      promptBox.textContent = 'You are the imposter, blend in.';
    } else {
      promptBox.textContent = prompt ? `Prompt: ${prompt}` : '';
    }
    yourTurnBox.textContent = '';
    doneTalkBtn.classList.add('hidden');
    if (phaseTimerEl) {
      phaseTimerEl.classList.add('hidden');
      phaseTimerEl.textContent = '';
    }
    if (gameRoomCodeEl) gameRoomCodeEl.textContent = currentRoomCode || '';
  });

  // Pre-talk reveal: show subject and prompt to everyone; imposter sees only subject with guidance
  socket.on('phasePreTalk', ({ subject, prompt, message }) => {
    showPhase('talk');
    gameMessage.textContent = '';
    const subjectLine = subject ? `Subject: ${subject}` : '';
    if (prompt) {
      promptBox.textContent = `${subjectLine}\nPrompt: ${prompt}`;
    } else {
      promptBox.textContent = `${subjectLine}\nBlend in, you're the imposter`;
    }
    yourTurnBox.textContent = message || '';
    doneTalkBtn.classList.add('hidden');
    if (phaseTimerEl) {
      // Keep timer hidden during pre-talk reveal
      phaseTimerEl.classList.add('hidden');
      phaseTimerEl.textContent = '';
    }
    if (gameRoomCodeEl) gameRoomCodeEl.textContent = currentRoomCode || '';
  });

  if (doneTalkBtn) doneTalkBtn.addEventListener('click', () => socket.emit('doneTalk'));

  socket.on('phaseVote', ({ candidates, voteRound, canGoAround }) => {
    showPhase('vote');
    candidatesEl.innerHTML = '';
    gameMessage.textContent = `Vote phase ${voteRound}`;
    candidates.filter(n => n !== youName).forEach(n => {
      const btn = document.createElement('button');
      btn.className = 'btn btn-primary';
      btn.textContent = n;
      btn.addEventListener('click', () => {
        socket.emit('voteFor', n);
        // Immediately lock voting
        candidatesEl.innerHTML = '';
        gameMessage.textContent = 'You voted, waiting on others.';
        goAgainBtn.classList.add('hidden');
        voteNote.textContent = '';
      });
      candidatesEl.appendChild(btn);
    });
    goAgainBtn.classList.toggle('hidden', !canGoAround);
    voteNote.textContent = canGoAround ? 'Or go around again' : 'Everyone must vote';
    if (phaseTimerEl) phaseTimerEl.classList.remove('hidden');
    if (gameRoomCodeEl) gameRoomCodeEl.textContent = currentRoomCode || '';
  });

  socket.on('phaseVoteImposter', ({ message }) => {
    showPhase('vote');
    candidatesEl.innerHTML = '';
    gameMessage.textContent = message;
    goAgainBtn.classList.add('hidden');
    voteNote.textContent = '';
    if (phaseTimerEl) phaseTimerEl.classList.remove('hidden');
    if (gameRoomCodeEl) gameRoomCodeEl.textContent = currentRoomCode || '';
  });

  socket.on('phaseVoteAlready', ({ message }) => {
    showPhase('vote');
    candidatesEl.innerHTML = '';
    gameMessage.textContent = message;
    goAgainBtn.classList.add('hidden');
    voteNote.textContent = '';
    if (phaseTimerEl) phaseTimerEl.classList.remove('hidden');
    if (gameRoomCodeEl) gameRoomCodeEl.textContent = currentRoomCode || '';
  });

  socket.on('phaseVoteWaiting', ({ message }) => {
    showPhase('vote');
    candidatesEl.innerHTML = '';
    gameMessage.textContent = message || 'Waiting on others.';
    goAgainBtn.classList.add('hidden');
    voteNote.textContent = '';
    if (phaseTimerEl) phaseTimerEl.classList.remove('hidden');
    if (gameRoomCodeEl) gameRoomCodeEl.textContent = currentRoomCode || '';
  });

  if (goAgainBtn) goAgainBtn.addEventListener('click', () => socket.emit('goAroundAgain'));

  socket.on('voteUpdate', ({ votes, votedBy }) => {
    // Optional: show live vote feedback
  });

  socket.on('phaseScoreReveal', ({ imposter }) => {
    showPhase('score');
    revealEl.textContent = `Imposter revealed: ${imposter}! 🎭`;
    revealEl.classList.add('fade-in');
    revealEl.classList.remove('hidden');
    scoreStream.innerHTML = '';
    scoreBoard.innerHTML = '';
    // Clear screen effect
    gameMessage.textContent = '';
    if (phaseTimerEl) phaseTimerEl.classList.add('hidden');
    if (phaseTimerEl) phaseTimerEl.textContent = '';
    if (gameRoomCodeEl) gameRoomCodeEl.textContent = currentRoomCode || '';
  });

  socket.on('phaseScorePlayer', ({ player, votedFor, points }) => {
    const li = document.createElement('li');
    li.textContent = `${player} voted for ${votedFor || 'nobody'} — +${points}`;
    li.classList.add('fade-in');
    if (points && points > 0) {
      li.classList.add('score-correct');
    } else {
      li.classList.add('score-wrong');
    }
    scoreStream.appendChild(li);
  });

  socket.on('phaseScoreImposter', ({ imposter, correctVotes, points }) => {
    const li = document.createElement('li');
    li.textContent = `Imposter ${imposter}: ${correctVotes} correct votes against — +${points}`;
    li.classList.add('fade-in');
    scoreStream.appendChild(li);
  });

  socket.on('phaseScoreBoard', ({ scoreboard }) => {
    // Clear previous reveal/stream before showing scoreboard
    revealEl.textContent = '';
    revealEl.classList.add('hidden');
    scoreStream.innerHTML = '';
    scoreBoard.innerHTML = '';
    if (phaseTimerEl) {
      phaseTimerEl.classList.add('hidden');
      phaseTimerEl.textContent = '';
    }
    scoreboard.forEach(row => {
      const li = document.createElement('li');
      const label = document.createElement('div');
      label.textContent = `#${row.place} ${row.name}`;
      const value = document.createElement('div');
      value.className = 'score-value';
      value.textContent = '0';
      li.appendChild(label);
      li.appendChild(value);
      li.classList.add('fade-in');
      scoreBoard.appendChild(li);
      animateNumber(value, row.score, 500);
    });
  });

  socket.on('gameEnded', ({ scoreboard, winner }) => {
    showPhase('score');
    const li = document.createElement('li');
    li.textContent = `Winner: ${winner ? winner.name : 'N/A'} — ${winner ? winner.score : 0}`;
    scoreBoard.appendChild(li);
    // Return to lobby after a short pause
    setTimeout(() => {
      showScreen(screenLobby);
      countdownEl.classList.add('hidden');
      cancelBtn.classList.add('hidden');
    }, 4000);
  });

  socket.on('gameState', (state) => {
    // Rejoin sync: route to current phase view
    showScreen(screenGame);
    if (!state) return;
    if (state.phase === 'choose') {
      gameMessage.textContent = `${state.chooser} is choosing a subject`;
      showPhase('choose');
    } else if (state.phase === 'talk') {
      showPhase('talk');
    } else if (state.phase === 'vote') {
      showPhase('vote');
    } else if (state.phase === 'score') {
      showPhase('score');
    }
  });

  function showPhase(which) {
    [choosePhase, talkPhase, votePhase, scorePhase].forEach(el => el.classList.add('hidden'));
    if (which === 'choose') choosePhase.classList.remove('hidden');
    if (which === 'talk') talkPhase.classList.remove('hidden');
    if (which === 'vote') votePhase.classList.remove('hidden');
    if (which === 'score') scorePhase.classList.remove('hidden');
  }

  // Server-driven phase timer display
  socket.on('phaseTimer', ({ phase, secondsLeft }) => {
    if (!phaseTimerEl) return;
    if (secondsLeft > 0) {
      phaseTimerEl.textContent = `${secondsLeft}s`;
      phaseTimerEl.classList.remove('hidden');
    } else {
      phaseTimerEl.textContent = '';
      phaseTimerEl.classList.add('hidden');
    }
  });

  function animateNumber(el, target, durationMs) {
    const start = 0;
    const startTime = performance.now();
    function step(now) {
      const t = Math.min(1, (now - startTime) / durationMs);
      const val = Math.round(start + (target - start) * t);
      el.textContent = String(val);
      if (t < 1) requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
  }
})();
