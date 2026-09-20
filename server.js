const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname, 'public')));

const players = {}; 
const games = {};   
const leaderboard = {}; 

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const GAME_URL = process.env.RENDER_EXTERNAL_URL || process.env.GAME_URL || '';

const NOTIFICATION_COOLDOWN_MS = 60 * 60 * 1000;
let lastNotificationTime = 0;

async function sendTelegramLobbyAlert(playerName) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;

  const now = Date.now();
  if (now - lastNotificationTime < NOTIFICATION_COOLDOWN_MS) return;
  lastNotificationTime = now;

  const payload = {
    chat_id: TELEGRAM_CHAT_ID,
    text: `*${playerName}* wartet in der Lobby!`,
    parse_mode: 'Markdown'
  };

  if (GAME_URL) {
    payload.reply_markup = {
      inline_keyboard: [[{ text: 'Jetzt duellieren', url: GAME_URL }]]
    };
  }

  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
  } catch (err) {
    console.error('Telegram-Fehler:', err);
  }
}

function getLobbyList() {
  return Object.values(players).map(p => ({
    id: p.id,
    name: p.name,
    status: p.status
  }));
}

function getLeaderboardList() {
  return Object.entries(leaderboard)
    .map(([name, stats]) => ({ name, wins: stats.wins, kills: stats.kills }))
    .sort((a, b) => b.wins - a.wins || b.kills - a.kills)
    .slice(0, 10);
}

io.on('connection', (socket) => {
  socket.on('join-lobby', (name) => {
    const cleanName = (name || 'Spieler').trim().substring(0, 16);

    if (players[socket.id] && players[socket.id].status === 'ingame') {
      players[socket.id].name = cleanName;
      return;
    }

    players[socket.id] = {
      id: socket.id,
      name: cleanName,
      status: 'lobby',
      gameId: null
    };

    if (!leaderboard[cleanName]) {
      leaderboard[cleanName] = { wins: 0, kills: 0 };
    }

    io.emit('lobby-update', getLobbyList());
    io.emit('leaderboard-update', getLeaderboardList());

    sendTelegramLobbyAlert(cleanName);
  });

  socket.on('send-challenge', (targetId) => {
    const sender = players[socket.id];
    const target = players[targetId];

    if (sender && target && target.status === 'lobby' && sender.status === 'lobby') {
      io.to(targetId).emit('challenge-received', {
        challengerId: sender.id,
        challengerName: sender.name
      });
    }
  });

  socket.on('decline-challenge', (challengerId) => {
    io.to(challengerId).emit('challenge-declined', {
      name: players[socket.id]?.name || 'Gegner'
    });
  });

  socket.on('accept-challenge', (challengerId) => {
    const p1 = players[challengerId];
    const p2 = players[socket.id];

    if (!p1 || !p2 || p1.status !== 'lobby' || p2.status !== 'lobby') return;

    const gameId = `game_${p1.id}_${p2.id}`;
    p1.status = 'ingame';
    p2.status = 'ingame';
    p1.gameId = gameId;
    p2.gameId = gameId;

    const gameData = {
      id: gameId,
      p1: p1.id,
      p2: p2.id,
      scores: { [p1.id]: 0, [p2.id]: 0 },
      timeLeft: 60,
      interval: null,
      isRoundLocked: false
    };

    games[gameId] = gameData;
    io.emit('lobby-update', getLobbyList());

    // P1 steht im Sueden bei Z=14 mit Blick nach Norden (rotY=0)
    // P2 steht im Norden bei Z=-14 mit Blick nach Sueden (rotY=Math.PI)
    const p1Spawn = { x: 0, y: 1.6, z: 14, rotY: 0 };
    const p2Spawn = { x: 0, y: 1.6, z: -14, rotY: Math.PI };

    io.to(p1.id).emit('match-start', {
      gameId,
      role: 'p1',
      opponentName: p2.name,
      opponentId: p2.id,
      spawn: p1Spawn,
      oppSpawn: p2Spawn
    });

    io.to(p2.id).emit('match-start', {
      gameId,
      role: 'p2',
      opponentName: p1.name,
      opponentId: p1.id,
      spawn: p2Spawn,
      oppSpawn: p1Spawn
    });

    gameData.interval = setInterval(() => {
      gameData.timeLeft -= 1;
      io.to(p1.id).emit('timer-tick', gameData.timeLeft);
      io.to(p2.id).emit('timer-tick', gameData.timeLeft);

      if (gameData.timeLeft <= 0) {
        endGame(gameId, 'time-up');
      }
    }, 1000);
  });

  socket.on('player-update', (data) => {
    const player = players[socket.id];
    if (!player || !player.gameId) return;
    const game = games[player.gameId];
    if (!game) return;

    const opponentId = game.p1 === socket.id ? game.p2 : game.p1;
    io.to(opponentId).emit('opponent-moved', data);
  });

  socket.on('hit-target', (targetId) => {
    const player = players[socket.id];
    if (!player || !player.gameId) return;

    const game = games[player.gameId];
    if (!game || game.isRoundLocked) return;

    game.isRoundLocked = true;
    game.scores[socket.id] += 1;
    if (leaderboard[player.name]) leaderboard[player.name].kills += 1;

    io.to(game.p1).emit('score-update', { myScore: game.scores[game.p1], oppScore: game.scores[game.p2] });
    io.to(game.p2).emit('score-update', { myScore: game.scores[game.p2], oppScore: game.scores[game.p1] });

    io.to(game.p1).emit('round-killed', { killerId: socket.id, victimId: targetId });
    io.to(game.p2).emit('round-killed', { killerId: socket.id, victimId: targetId });

    setTimeout(() => {
      if (!games[game.id]) return;

      const p1Spawn = { x: (Math.random() - 0.5) * 6, y: 1.6, z: 14, rotY: 0 };
      const p2Spawn = { x: (Math.random() - 0.5) * 6, y: 1.6, z: -14, rotY: Math.PI };

      io.to(game.p1).emit('round-resume', { mySpawn: p1Spawn, oppSpawn: p2Spawn });
      io.to(game.p2).emit('round-resume', { mySpawn: p2Spawn, oppSpawn: p1Spawn });

      game.isRoundLocked = false;
    }, 4000);
  });

  socket.on('shot-fired', (data) => {
    const player = players[socket.id];
    if (!player || !player.gameId) return;
    const game = games[player.gameId];
    if (!game) return;

    const opponentId = game.p1 === socket.id ? game.p2 : game.p1;
    io.to(opponentId).emit('opponent-shot', data);
  });

  socket.on('disconnect', () => {
    const player = players[socket.id];
    if (player) {
      if (player.gameId && games[player.gameId]) {
        endGame(player.gameId, 'opponent-disconnected', socket.id);
      }
      delete players[socket.id];
      io.emit('lobby-update', getLobbyList());
    }
  });
});

function endGame(gameId, reason, disconnectedId = null) {
  const game = games[gameId];
  if (!game) return;

  clearInterval(game.interval);

  const p1 = players[game.p1];
  const p2 = players[game.p2];

  let winnerName = 'Unentschieden';
  if (reason === 'opponent-disconnected') {
    winnerName = disconnectedId === game.p1 ? p2?.name : p1?.name;
  } else {
    if (game.scores[game.p1] > game.scores[game.p2]) {
      winnerName = p1?.name;
      if (p1 && leaderboard[p1.name]) leaderboard[p1.name].wins += 1;
    } else if (game.scores[game.p2] > game.scores[game.p1]) {
      winnerName = p2?.name;
      if (p2 && leaderboard[p2.name]) leaderboard[p2.name].wins += 1;
    }
  }

  const resultPayload = {
    winner: winnerName,
    p1Name: p1?.name,
    p2Name: p2?.name,
    p1Score: game.scores[game.p1],
    p2Score: game.scores[game.p2]
  };

  if (p1) {
    p1.status = 'lobby';
    p1.gameId = null;
    io.to(p1.id).emit('game-over', resultPayload);
  }
  if (p2) {
    p2.status = 'lobby';
    p2.gameId = null;
    io.to(p2.id).emit('game-over', resultPayload);
  }

  delete games[gameId];
  io.emit('lobby-update', getLobbyList());
  io.emit('leaderboard-update', getLeaderboardList());
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server laeuft auf Port ${PORT}`);
});
