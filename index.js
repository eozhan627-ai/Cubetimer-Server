import express from 'express';
import http from 'http';
import cors from 'cors';
import dotenv from 'dotenv';
import crypto from 'crypto';
import { Server } from 'socket.io';
import { v4 as uuid } from 'uuid';
import { pool } from './db.js';
import { joinQueue, removeFromQueues, removeSocket, findMatches } from './matchmaking.js';

dotenv.config();

const COUNTDOWN_MS = 3000;
const DNF_MS = 999999999;
const K_FACTOR = 32;
const RATING_FLOOR = 100;
const MATCH_KEEP_MS = 10 * 60 * 1000; // so lange kann ein Match noch gemeldet werden

const hashToken = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');
const safeEqual = (a, b) =>
  crypto.timingSafeEqual(
    crypto.createHash('sha256').update(String(a)).digest(),
    crypto.createHash('sha256').update(String(b)).digest()
  );
const isUuid = (v) =>
  typeof v === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);

function eloDelta(winnerRating, loserRating) {
  const expected = 1 / (1 + Math.pow(10, (loserRating - winnerRating) / 400));
  return Math.round(K_FACTOR * (1 - expected));
}

const app = express();
app.use(cors({ origin: process.env.CLIENT_ORIGIN || '*' }));
app.use(express.json());

app.get('/health', (_req, res) => res.json({ ok: true }));

// --- Anonyme Konten: Gerät registriert sich einmal, bekommt userId + geheimen Token ---
app.post('/register', async (req, res) => {
  const username = String(req.body?.username ?? '').trim();
  if (!/^[A-Za-z0-9_]{3,20}$/.test(username)) {
    return res.status(400).json({ error: 'invalid_username' });
  }
  const token = crypto.randomBytes(24).toString('hex');
  try {
    const { rows } = await pool.query(
      `INSERT INTO users (username, auth_token_hash) VALUES ($1, $2) RETURNING id, username`,
      [username, hashToken(token)]
    );
    res.json({ userId: rows[0].id, token, username: rows[0].username });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'username_taken' });
    console.error('Registrierung fehlgeschlagen:', err);
    res.status(500).json({ error: 'server_error' });
  }
});

// --- Profil (öffentlich lesbar über die nicht erratbare UUID, ohne geheime Felder) ---
app.get('/profile/:userId', async (req, res) => {
  const { userId } = req.params;
  if (!isUuid(userId)) return res.status(400).json({ error: 'invalid_id' });
  try {
    const user = await pool.query(
      `SELECT username, rating, trust_score, is_vip, created_at FROM users WHERE id = $1`,
      [userId]
    );
    if (user.rowCount === 0) return res.status(404).json({ error: 'not_found' });

    const cats = await pool.query(
      `SELECT category, COUNT(*)::int AS count
         FROM solves WHERE user_id = $1 AND is_online
         GROUP BY category ORDER BY count DESC`,
      [userId]
    );
    const u = user.rows[0];
    res.json({
      username: u.username,
      rating: u.rating,
      trustScore: u.trust_score,
      isVip: u.is_vip,
      createdAt: u.created_at,
      onlineSolves: cats.rows.reduce((sum, r) => sum + r.count, 0),
      byCategory: cats.rows,
    });
  } catch (err) {
    console.error('Profil konnte nicht geladen werden:', err);
    res.status(500).json({ error: 'server_error' });
  }
});

// --- Report-Entscheidung durch Support (geschützt über ADMIN_KEY) ---
// valid=true  -> gemeldeter Spieler verliert 25 Trust
// valid=false -> unbegründete Meldung, Melder verliert 5 Trust
app.post('/admin/reports/:id/resolve', async (req, res) => {
  const key = process.env.ADMIN_KEY;
  if (!key || !safeEqual(req.get('x-admin-key') ?? '', key)) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  const { id } = req.params;
  const valid = req.body?.valid;
  if (!isUuid(id) || typeof valid !== 'boolean') {
    return res.status(400).json({ error: 'bad_request' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await client.query(
      `SELECT reporter_id, reported_id FROM reports WHERE id = $1 AND status = 'pending' FOR UPDATE`,
      [id]
    );
    if (r.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'not_found_or_resolved' });
    }
    const { reporter_id, reported_id } = r.rows[0];
    await client.query(`UPDATE reports SET status = $2 WHERE id = $1`, [
      id,
      valid ? 'reviewed_valid' : 'reviewed_invalid',
    ]);
    if (valid) {
      await client.query(
        `UPDATE users SET trust_score = GREATEST(0, trust_score - 25) WHERE id = $1`,
        [reported_id]
      );
    } else {
      await client.query(
        `UPDATE users SET trust_score = GREATEST(0, trust_score - 5) WHERE id = $1`,
        [reporter_id]
      );
    }
    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => { });
    console.error('Report konnte nicht entschieden werden:', err);
    res.status(500).json({ error: 'server_error' });
  } finally {
    client.release();
  }
});

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: process.env.CLIENT_ORIGIN || '*' },
});

// matchId -> { category, players: { [userId]: { socketId, ready, stoppedAt, timeMs } }, startAt, finished }
const activeMatches = new Map();

// --- Socket-Authentifizierung: userId + Token müssen zusammenpassen ---
io.use(async (socket, next) => {
  const { userId, token } = socket.handshake.auth ?? {};
  if (!isUuid(userId) || !token) return next(new Error('unauthorized'));
  try {
    const { rows } = await pool.query(
      `SELECT id, username FROM users WHERE id = $1 AND auth_token_hash = $2`,
      [userId, hashToken(token)]
    );
    if (rows.length === 0) return next(new Error('unauthorized'));
    socket.data.userId = rows[0].id;
    socket.data.username = rows[0].username;
    next();
  } catch (err) {
    console.error('Socket-Auth fehlgeschlagen:', err);
    next(new Error('server_error'));
  }
});

io.on('connection', (socket) => {
  // --- Matchmaking: Rating kommt aus der DB, nicht vom Client ---
  socket.on('queue:join', async ({ category } = {}) => {
    if (typeof category !== 'string' || category.length === 0 || category.length > 40) return;
    const userId = socket.data.userId;
    try {
      const { rows } = await pool.query(`SELECT username, rating FROM users WHERE id = $1`, [userId]);
      if (rows.length === 0) return;
      joinQueue({
        socketId: socket.id,
        userId,
        category,
        rating: rows[0].rating,
        username: rows[0].username,
      });
    } catch (err) {
      console.error('queue:join fehlgeschlagen:', err);
    }
  });

  socket.on('queue:leave', () => removeFromQueues(socket.data.userId));

  // --- Kamera-Bereitschaft ---
  socket.on('match:camera-ready', ({ matchId } = {}) => {
    const match = activeMatches.get(matchId);
    if (!match || match.finished) return;
    const player = match.players[socket.data.userId];
    if (!player) return;
    player.ready = true;

    const allReady = Object.values(match.players).every((p) => p.ready);
    if (allReady && !match.startAt) {
      match.startAt = Date.now() + COUNTDOWN_MS;
      // countdownMs statt absoluter Uhrzeit: die Handy-Uhr muss nicht mit der Server-Uhr übereinstimmen
      for (const p of Object.values(match.players)) {
        io.to(p.socketId).emit('match:countdown', { matchId, countdownMs: COUNTDOWN_MS });
      }
    }
  });

  // --- Stopp: die Server-Zeit entscheidet ---
  socket.on('match:stop', ({ matchId } = {}) => {
    const match = activeMatches.get(matchId);
    if (!match || match.finished || !match.startAt) return;

    const userId = socket.data.userId;
    const player = match.players[userId];
    if (!player || player.stoppedAt) return;

    const now = Date.now();
    player.stoppedAt = now;
    // Stopp vor dem Start kann nur von einem manipulierten Client kommen -> DNF
    player.timeMs = now < match.startAt ? DNF_MS : now - match.startAt;

    const allStopped = Object.values(match.players).every((p) => p.stoppedAt);
    if (allStopped) {
      finishMatch(matchId);
    } else {
      for (const p of Object.values(match.players)) {
        if (p.socketId !== socket.id) io.to(p.socketId).emit('match:opponent-stopped');
      }
    }
  });

  // --- WebRTC-Signaling (für Phase 2) ---
  socket.on('webrtc:signal', ({ matchId, targetUserId, data } = {}) => {
    const match = activeMatches.get(matchId);
    if (!match || !match.players[socket.data.userId]) return;
    const target = match.players[targetUserId];
    if (target) {
      io.to(target.socketId).emit('webrtc:signal', { fromUserId: socket.data.userId, data });
    }
  });

  // --- Report ---
  socket.on('match:report', async ({ matchId, reason } = {}) => {
    const match = activeMatches.get(matchId);
    if (!match) return;
    const reporterId = socket.data.userId;
    if (!match.players[reporterId]) return;
    const reportedId = Object.keys(match.players).find((id) => id !== reporterId);
    if (!reportedId) return;

    try {
      await pool.query(
        `INSERT INTO reports (match_id, reporter_id, reported_id, reason)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (match_id, reporter_id) DO NOTHING`,
        [matchId, reporterId, reportedId, String(reason ?? '').slice(0, 200) || null]
      );
      match.reported = true; // Client weiß dadurch: Video hochladen statt verwerfen
      socket.emit('match:report-received', { matchId });
    } catch (err) {
      console.error('Report konnte nicht gespeichert werden:', err);
    }
  });

  socket.on('disconnect', () => {
    const userId = socket.data.userId;
    removeFromQueues(userId);
    removeSocket(socket.id);

    // Laufendes Match abbrechen, damit der Gegner nicht ewig wartet (ohne Rating-Änderung)
    for (const [matchId, match] of activeMatches) {
      const me = match.players[userId];
      if (!me || me.socketId !== socket.id || match.finished) continue;
      match.finished = true;
      for (const [id, p] of Object.entries(match.players)) {
        if (id !== userId) io.to(p.socketId).emit('match:aborted', { matchId });
      }
      pool
        .query(`DELETE FROM matches WHERE id = $1 AND finished_at IS NULL`, [matchId])
        .catch((err) => console.error('Abgebrochenes Match nicht gelöscht:', err));
      activeMatches.delete(matchId);
    }
  });
});

async function finishMatch(matchId) {
  const match = activeMatches.get(matchId);
  if (!match || match.finished) return;
  match.finished = true;

  const [id1, id2] = Object.keys(match.players); // Reihenfolge = player1, player2 aus der Match-Erstellung
  const p1 = match.players[id1];
  const p2 = match.players[id2];
  const winnerId = p1.timeMs <= p2.timeMs ? id1 : id2;
  const loserId = winnerId === id1 ? id2 : id1;

  let ratingChanges = null;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows } = await client.query(
      `SELECT id, rating FROM users WHERE id = ANY($1::uuid[]) FOR UPDATE`,
      [[id1, id2]]
    );
    const rating = Object.fromEntries(rows.map((r) => [r.id, r.rating]));
    const delta = eloDelta(rating[winnerId], rating[loserId]);
    const newWinner = Math.max(RATING_FLOOR, rating[winnerId] + delta);
    const newLoser = Math.max(RATING_FLOOR, rating[loserId] - delta);

    // Rating aktualisieren; sauber gespielte Matches erhöhen den Trust Score langsam
    await client.query(
      `UPDATE users SET rating = $2, trust_score = LEAST(100, trust_score + 1) WHERE id = $1`,
      [winnerId, newWinner]
    );
    await client.query(
      `UPDATE users SET rating = $2, trust_score = LEAST(100, trust_score + 1) WHERE id = $1`,
      [loserId, newLoser]
    );

    for (const [id, p] of [[id1, p1], [id2, p2]]) {
      if (p.timeMs >= DNF_MS) continue; // DNF zählt nicht in die Solve-Statistik
      await client.query(
        `INSERT INTO solves (user_id, category, time_ms, is_online, match_id)
         VALUES ($1, $2, $3, TRUE, $4)`,
        [id, match.category, p.timeMs, matchId]
      );
    }

    await client.query(
      `UPDATE matches
          SET winner_id = $1, player1_time_ms = $2, player2_time_ms = $3, finished_at = now()
        WHERE id = $4`,
      [winnerId, p1.timeMs, p2.timeMs, matchId]
    );

    await client.query('COMMIT');
    ratingChanges = {
      [winnerId]: { delta: newWinner - rating[winnerId], newRating: newWinner },
      [loserId]: { delta: newLoser - rating[loserId], newRating: newLoser },
    };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => { });
    console.error('Match-Ergebnis konnte nicht gespeichert werden:', err);
  } finally {
    client.release();
  }

  for (const p of Object.values(match.players)) {
    io.to(p.socketId).emit('match:result', {
      matchId,
      winnerId,
      times: { [id1]: p1.timeMs, [id2]: p2.timeMs },
      ratingChanges,
    });
  }

  // Match noch eine Weile im Speicher lassen, damit Reports möglich bleiben
  setTimeout(() => activeMatches.delete(matchId), MATCH_KEEP_MS);
}

// Matchmaking-Loop: prüft jede Sekunde auf passende Paare
let matching = false;
setInterval(async () => {
  if (matching) return;
  matching = true;
  try {
    for (const { category, player1, player2 } of findMatches()) {
      const matchId = uuid();

      try {
        await pool.query(
          `INSERT INTO matches (id, category, player1_id, player2_id) VALUES ($1, $2, $3, $4)`,
          [matchId, category, player1.userId, player2.userId]
        );
      } catch (err) {
        console.error('Match konnte nicht in DB angelegt werden:', err);
        // beide zurück in die Warteschlange, statt ein Match ohne DB-Eintrag zu starten
        joinQueue({ ...player1, category });
        joinQueue({ ...player2, category });
        continue;
      }

      activeMatches.set(matchId, {
        category,
        players: {
          [player1.userId]: { socketId: player1.socketId, ready: false },
          [player2.userId]: { socketId: player2.socketId, ready: false },
        },
        startAt: null,
        finished: false,
      });

      io.to(player1.socketId).emit('match:found', {
        matchId,
        category,
        opponentUserId: player2.userId,
        opponentName: player2.username,
        opponentRating: player2.rating,
      });
      io.to(player2.socketId).emit('match:found', {
        matchId,
        category,
        opponentUserId: player1.userId,
        opponentName: player1.username,
        opponentRating: player1.rating,
      });
    }
  } finally {
    matching = false;
  }
}, 1000);

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => console.log(`cube-timer-server läuft auf Port ${PORT}`));