import express from 'express';
import http from 'http';
import cors from 'cors';
import dotenv from 'dotenv';
import { Server } from 'socket.io';
import { v4 as uuid } from 'uuid';
import { pool } from './db.js';
import { joinQueue, removeFromQueues, removeSocket, findMatches } from './matchmaking.js';

dotenv.config();

const app = express();
app.use(cors({ origin: process.env.CLIENT_ORIGIN || '*' }));
app.use(express.json());

app.get('/health', (_req, res) => res.json({ ok: true }));

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: process.env.CLIENT_ORIGIN || '*' },
});

// matchId -> { category, players: { [userId]: { socketId, ready, stoppedAt } }, startAt }
const activeMatches = new Map();

io.on('connection', (socket) => {
  // --- Matchmaking ---
  socket.on('queue:join', ({ userId, category, rating }) => {
    socket.data.userId = userId;
    joinQueue({ socketId: socket.id, userId, category, rating: rating ?? 1200 });
  });

  socket.on('queue:leave', () => {
    if (socket.data.userId) removeFromQueues(socket.data.userId);
  });

  // --- Kamera-Bereitschaft ---
  socket.on('match:camera-ready', ({ matchId }) => {
    const match = activeMatches.get(matchId);
    if (!match) return;
    const player = match.players[socket.data.userId];
    if (!player) return;
    player.ready = true;

    const allReady = Object.values(match.players).every((p) => p.ready);
    if (allReady && !match.startAt) {
      match.startAt = Date.now() + 3000; // 3-Sek-Countdown, serverseitig festgelegt
      for (const p of Object.values(match.players)) {
        io.to(p.socketId).emit('match:countdown', { matchId, startAt: match.startAt });
      }
    }
  });

  // --- Stopp-Event: Server-Zeit entscheidet, nicht Client-Zeit ---
  socket.on('match:stop', ({ matchId }) => {
    const match = activeMatches.get(matchId);
    if (!match || !match.startAt) return;

    const userId = socket.data.userId;
    const player = match.players[userId];
    if (!player || player.stoppedAt) return; // schon gestoppt, ignorieren

    player.stoppedAt = Date.now();
    player.timeMs = player.stoppedAt - match.startAt;

    const allStopped = Object.values(match.players).every((p) => p.stoppedAt);
    if (allStopped) {
      finishMatch(matchId);
    } else {
      // Gegner informieren, dass der andere fertig ist (fürs UI, z.B. "Gegner ist fertig")
      for (const p of Object.values(match.players)) {
        if (p.socketId !== socket.id) io.to(p.socketId).emit('match:opponent-stopped');
      }
    }
  });

  // --- WebRTC-Signaling: Server leitet nur weiter, sieht das Video selbst nicht ---
  socket.on('webrtc:signal', ({ matchId, targetUserId, data }) => {
    const match = activeMatches.get(matchId);
    if (!match) return;
    const target = match.players[targetUserId];
    if (target) io.to(target.socketId).emit('webrtc:signal', { fromUserId: socket.data.userId, data });
  });

  // --- Report: markiert das Match für Video-Review statt sofortigem Löschen ---
  socket.on('match:report', async ({ matchId, reason }) => {
    const match = activeMatches.get(matchId);
    if (!match) return;
    const reporterId = socket.data.userId;
    const reportedId = Object.keys(match.players).find((id) => id !== reporterId);
    if (!reportedId) return;

    try {
      await pool.query(
        `INSERT INTO reports (match_id, reporter_id, reported_id, reason) VALUES ($1, $2, $3, $4)`,
        [matchId, reporterId, reportedId, reason ?? null]
      );
      match.reported = true; // Client weiß dadurch: Video hochladen statt verwerfen
    } catch (err) {
      console.error('Report konnte nicht gespeichert werden:', err);
    }
  });

  socket.on('disconnect', () => {
    if (socket.data.userId) removeFromQueues(socket.data.userId);
    removeSocket(socket.id);
    // TODO: laufendes Match als abgebrochen markieren und Gegner benachrichtigen
  });
});

async function finishMatch(matchId) {
  const match = activeMatches.get(matchId);
  if (!match) return;

  const [id1, id2] = Object.keys(match.players);
  const p1 = match.players[id1];
  const p2 = match.players[id2];
  const winnerId = p1.timeMs <= p2.timeMs ? id1 : id2;

  for (const p of Object.values(match.players)) {
    io.to(p.socketId).emit('match:result', {
      matchId,
      winnerId,
      times: { [id1]: p1.timeMs, [id2]: p2.timeMs },
    });
  }

  try {
    await pool.query(
      `UPDATE matches SET winner_id = $1, player1_time_ms = $2, player2_time_ms = $3, finished_at = now() WHERE id = $4`,
      [winnerId, p1.timeMs, p2.timeMs, matchId]
    );
  } catch (err) {
    console.error('Match-Ergebnis konnte nicht gespeichert werden:', err);
  }

  // Match nach kurzer Zeit aus dem Speicher nehmen (Report kommt ggf. noch kurz danach)
  setTimeout(() => activeMatches.delete(matchId), 30_000);
}

// Matchmaking-Loop: prüft alle 1s auf passende Paare
setInterval(async () => {
  const matches = findMatches();

  for (const { category, player1, player2 } of matches) {
    const matchId = uuid();

    activeMatches.set(matchId, {
      category,
      players: {
        [player1.userId]: { socketId: player1.socketId, ready: false },
        [player2.userId]: { socketId: player2.socketId, ready: false },
      },
      startAt: null,
    });

    try {
      await pool.query(
        `INSERT INTO matches (id, category, player1_id, player2_id) VALUES ($1, $2, $3, $4)`,
        [matchId, category, player1.userId, player2.userId]
      );
    } catch (err) {
      console.error('Match konnte nicht in DB angelegt werden:', err);
    }

    io.to(player1.socketId).emit('match:found', {
      matchId,
      category,
      opponentUserId: player2.userId,
    });
    io.to(player2.socketId).emit('match:found', {
      matchId,
      category,
      opponentUserId: player1.userId,
    });
  }
}, 1000);

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => console.log(`cube-timer-server läuft auf Port ${PORT}`));