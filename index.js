import express from 'express';
import http from 'http';
import cors from 'cors';
import dotenv from 'dotenv';
import crypto from 'crypto';
import fs from 'fs';
import { Server } from 'socket.io';
import { pool } from './db.js';
import { joinQueue, removeFromQueues, removeSocket, findMatches } from './matchmaking.js';
import { generateScramble } from './scramble.js';
import { DNF_MS, eloDelta, hasValidTime, pickWinner, createLimiter } from './rules.js';

dotenv.config();

const COUNTDOWN_MS = 3000;
const READY_TIMEOUT_MS = 60 * 1000; // so lange haben beide Zeit, "Bereit" zu drücken
const MAX_MATCH_MS = 10 * 60 * 1000; // danach bekommt, wer noch nicht gestoppt hat, ein DNF
const RATING_FLOOR = 100;
const MATCH_KEEP_MS = 10 * 60 * 1000; // so lange kann ein Match noch gemeldet werden

// --- Anti-Cheat-Einstellungen ---
const ONLINE_CATEGORIES = ['3×3']; // Kategorien, in denen online gespielt werden darf
const SOLO_CATEGORIES = new Set([
  '2×2', '2×2 One-Handed', '2×2 Blindfolded',
  '3×3', '3×3 One-Handed', '3×3 Blindfolded',
  '4×4', '5×5', '6×6', '7×7', '8×8', '9×9', '10×10', '11×11', '12×12', '13×13', '21×21',
]);
const MIN_SOLO_SOLVES = 20; // gültige Solo-Solves pro Kategorie, bevor man online spielen darf
const MIN_SOLO_GAP_MS = 10 * 1000; // Mindestabstand zwischen zwei zählenden Solo-Solves
const MIN_SOLO_MS = 500;
const MAX_SOLO_MS = 60 * 60 * 1000;
const MIN_ONLINE_MS = 1500; // schneller kann kein Mensch einen gemischten Cube lösen -> auffällig
const PLAUSIBILITY_FACTOR = 0.5; // Online-Zeit unter 50 % des Solo-Medians -> auffällig
const PLAUSIBILITY_TRUST_PENALTY = 15;
const REPORT_WINDOW_MIN = 30; // Zeitfenster für die Häufungsprüfung
const REPORT_CLUSTER = 3; // so viele verschiedene, glaubwürdige Melder im Fenster -> vorläufige Sperre
const BAN_HOURS = 24;
const REPORT_REASONS = new Set(['no_stop', 'instant_stop', 'other']);

const hashToken = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');
const safeEqual = (a, b) =>
  crypto.timingSafeEqual(
    crypto.createHash('sha256').update(String(a)).digest(),
    crypto.createHash('sha256').update(String(b)).digest()
  );
const isUuid = (v) =>
  typeof v === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);

const USERNAME_RE = /^[A-Za-z0-9_]{3,20}$/;

const app = express();
app.set('trust proxy', 1); // hinter dem Render-Proxy, sonst hätten alle Clients dieselbe IP
app.use(cors({ origin: process.env.CLIENT_ORIGIN || '*' }));
app.use(express.json({ limit: '10kb' }));

// --- Rate-Limits: verhindert, dass jemand massenhaft Konten anlegt oder die DB flutet ---
function rateLimit(options, keyOf = (req) => req.ip) {
  const allow = createLimiter(options);
  return (req, res, next) => {
    if (allow(keyOf(req))) return next();
    res.status(429).json({ error: 'too_many_requests' });
  };
}
const generalLimit = rateLimit({ windowMs: 60 * 1000, max: 300 });
const registerLimit = rateLimit({ windowMs: 60 * 60 * 1000, max: 10 });
const renameLimit = rateLimit({ windowMs: 60 * 60 * 1000, max: 5 }, (req) => req.userId);

app.get('/health', (_req, res) => res.json({ ok: true }));

// --- Auth für normale HTTP-Requests: Header x-user-id + x-auth-token ---
async function requireAuth(req, res, next) {
  const userId = req.get('x-user-id');
  const token = req.get('x-auth-token');
  if (!isUuid(userId) || !token) return res.status(401).json({ error: 'unauthorized' });
  try {
    const { rows } = await pool.query(
      `SELECT id FROM users WHERE id = $1 AND auth_token_hash = $2`,
      [userId, hashToken(token)]
    );
    if (rows.length === 0) return res.status(401).json({ error: 'unauthorized' });
    req.userId = rows[0].id;
    next();
  } catch (err) {
    console.error('HTTP-Auth fehlgeschlagen:', err);
    res.status(500).json({ error: 'server_error' });
  }
}

// Zählt Solo-Solves, die mindestens MIN_SOLO_GAP_MS nach dem vorherigen liegen
async function countValidSolo(userId, category) {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM (
       SELECT solved_at - LAG(solved_at) OVER (ORDER BY solved_at) AS gap
         FROM solves
        WHERE user_id = $1 AND category = $2 AND NOT is_online
     ) t
     WHERE gap IS NULL OR gap >= make_interval(secs => $3)`,
    [userId, category, MIN_SOLO_GAP_MS / 1000]
  );
  return rows[0].n;
}

// --- Anonyme Konten: Gerät registriert sich einmal, bekommt userId + geheimen Token ---
app.post('/register', registerLimit, async (req, res) => {
  const username = String(req.body?.username ?? '').trim();
  if (!USERNAME_RE.test(username)) {
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

// --- Benutzernamen ändern ---
app.post('/username', requireAuth, renameLimit, async (req, res) => {
  const username = String(req.body?.username ?? '').trim();
  if (!USERNAME_RE.test(username)) return res.status(400).json({ error: 'invalid_username' });
  try {
    await pool.query(`UPDATE users SET username = $2 WHERE id = $1`, [req.userId, username]);
    res.json({ username });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'username_taken' });
    console.error('Umbenennen fehlgeschlagen:', err);
    res.status(500).json({ error: 'server_error' });
  }
});

// --- Solo-Solve hochladen (Vergleichsbasis für die Plausibilitätsprüfung) ---
app.post('/solves', generalLimit, requireAuth, async (req, res) => {
  const { category, timeMs, solvedAt } = req.body ?? {};
  if (
    !SOLO_CATEGORIES.has(category) ||
    !Number.isInteger(timeMs) || timeMs < MIN_SOLO_MS || timeMs > MAX_SOLO_MS ||
    !Number.isInteger(solvedAt)
  ) {
    return res.status(400).json({ error: 'bad_request' });
  }
  const now = Date.now();
  if (solvedAt > now + 60 * 1000 || solvedAt < now - 30 * 24 * 3600 * 1000) {
    return res.status(400).json({ error: 'bad_time' });
  }
  try {
    await pool.query(
      `INSERT INTO solves (user_id, category, time_ms, is_online, solved_at)
       VALUES ($1, $2, $3, FALSE, to_timestamp($4::double precision / 1000))
       ON CONFLICT (user_id, category, solved_at) WHERE NOT is_online DO NOTHING`,
      [req.userId, category, timeMs, solvedAt]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('Solo-Solve konnte nicht gespeichert werden:', err);
    res.status(500).json({ error: 'server_error' });
  }
});

// --- Darf der Spieler online spielen? (für die Anzeige "12/20") ---
app.get('/eligibility', generalLimit, requireAuth, async (req, res) => {
  const category = String(req.query.category ?? '');
  if (!ONLINE_CATEGORIES.includes(category)) return res.status(400).json({ error: 'bad_category' });
  try {
    const have = await countValidSolo(req.userId, category);
    const { rows } = await pool.query(
      `SELECT (online_banned_until IS NOT NULL AND online_banned_until > now()) AS banned FROM users WHERE id = $1`,
      [req.userId]
    );
    res.json({ have, need: MIN_SOLO_SOLVES, banned: rows[0]?.banned ?? false });
  } catch (err) {
    console.error('Eligibility fehlgeschlagen:', err);
    res.status(500).json({ error: 'server_error' });
  }
});

// --- Profil (öffentlich lesbar über die nicht erratbare UUID, ohne geheime Felder) ---
app.get('/profile/:userId', generalLimit, async (req, res) => {
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
  maxHttpBufferSize: 100 * 1024, // die Events sind winzig – große Pakete braucht niemand
});

// matchId -> { category, scramble, players: { [userId]: { socketId, ready, stoppedAt, timeMs, forfeit } }, startAt, finished, timer }
const activeMatches = new Map();
// userId -> matchId, solange das Match läuft (verhindert doppeltes Anstellen und macht den Disconnect billig)
const userMatch = new Map();

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

// Mehrere glaubwürdige Melder in kurzer Zeit -> Spieler wird vorläufig vom Online-Spiel ausgeschlossen.
// Der Trust-Score-Abzug kommt erst, wenn du den Report per Admin-Endpoint bestätigst.
async function checkReportCluster(reportedId) {
  const { rows } = await pool.query(
    `SELECT COUNT(DISTINCT r.reporter_id)::int AS n
       FROM reports r
       JOIN users u ON u.id = r.reporter_id
      WHERE r.reported_id = $1
        AND r.status <> 'reviewed_invalid'
        AND r.created_at > now() - make_interval(mins => $2)
        AND u.trust_score >= 50
        AND u.created_at < now() - interval '1 day'`,
    [reportedId, REPORT_WINDOW_MIN]
  );
  if (rows[0].n >= REPORT_CLUSTER) {
    await pool.query(
      `UPDATE users SET online_banned_until = now() + make_interval(hours => $2)
        WHERE id = $1 AND (online_banned_until IS NULL OR online_banned_until < now())`,
      [reportedId, BAN_HOURS]
    );
    removeFromQueues(reportedId);
  }
}

function clearMatchTimer(match) {
  if (match.timer) clearTimeout(match.timer);
  match.timer = null;
}

// Match ohne Wertung beenden (vor dem Start: jemand ist weg oder bestätigt nicht)
function abortMatch(matchId, reason) {
  const match = activeMatches.get(matchId);
  if (!match || match.finished) return;
  match.finished = true;
  clearMatchTimer(match);
  for (const [id, p] of Object.entries(match.players)) {
    userMatch.delete(id);
    io.to(p.socketId).emit('match:aborted', { matchId, reason });
  }
  pool
    .query(`DELETE FROM matches WHERE id = $1 AND finished_at IS NULL`, [matchId])
    .catch((err) => console.error('Abgebrochenes Match nicht gelöscht:', err));
  activeMatches.delete(matchId);
}

// Niemand darf ein Match ewig offen halten: wer nach MAX_MATCH_MS nicht gestoppt hat, bekommt ein DNF
function timeoutMatch(matchId) {
  const match = activeMatches.get(matchId);
  if (!match || match.finished) return;
  for (const p of Object.values(match.players)) {
    if (p.stoppedAt) continue;
    p.stoppedAt = Date.now();
    p.timeMs = DNF_MS;
  }
  finishMatch(matchId).catch((err) => console.error('finishMatch fehlgeschlagen:', err));
}

io.on('connection', (socket) => {
  // --- Matchmaking: Rating kommt aus der DB, nicht vom Client ---
  socket.on('queue:join', async ({ category } = {}) => {
    if (typeof category !== 'string' || category.length === 0 || category.length > 40) return;
    const userId = socket.data.userId;

    if (!ONLINE_CATEGORIES.includes(category)) {
      socket.emit('queue:denied', { reason: 'category_unavailable' });
      return;
    }
    if (userMatch.has(userId)) return; // steckt noch in einem laufenden Match

    try {
      const { rows } = await pool.query(
        `SELECT username, rating, online_banned_until FROM users WHERE id = $1`,
        [userId]
      );
      if (rows.length === 0) return;

      const until = rows[0].online_banned_until;
      if (until && new Date(until) > new Date()) {
        socket.emit('queue:denied', { reason: 'banned', until });
        return;
      }

      const have = await countValidSolo(userId, category);
      if (have < MIN_SOLO_SOLVES) {
        socket.emit('queue:denied', { reason: 'not_enough_solves', have, need: MIN_SOLO_SOLVES });
        return;
      }

      // Während der DB-Abfragen kann die Verbindung weg oder ein Match entstanden sein
      if (!socket.connected || userMatch.has(userId)) return;

      joinQueue({
        socketId: socket.id,
        userId,
        category,
        rating: rows[0].rating,
        username: rows[0].username,
      });
    } catch (err) {
      console.error('queue:join fehlgeschlagen:', err);
      socket.emit('queue:denied', { reason: 'server_error' });
    }
  });

  socket.on('queue:leave', () => removeFromQueues(socket.data.userId));

  // --- Bereitschaft ---
  socket.on('match:camera-ready', ({ matchId } = {}) => {
    const match = activeMatches.get(matchId);
    if (!match || match.finished) return;
    const player = match.players[socket.data.userId];
    if (!player || player.socketId !== socket.id) return;
    player.ready = true;

    const allReady = Object.values(match.players).every((p) => p.ready);
    if (allReady && !match.startAt) {
      clearMatchTimer(match);
      match.startAt = Date.now() + COUNTDOWN_MS;
      match.timer = setTimeout(() => timeoutMatch(matchId), COUNTDOWN_MS + MAX_MATCH_MS);
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
    if (!player || player.socketId !== socket.id || player.stoppedAt) return;

    const now = Date.now();
    player.stoppedAt = now;
    // Stopp vor dem Start kann nur von einem manipulierten Client kommen -> DNF
    player.timeMs = now < match.startAt ? DNF_MS : now - match.startAt;

    const allStopped = Object.values(match.players).every((p) => p.stoppedAt);
    if (allStopped) {
      finishMatch(matchId).catch((err) => console.error('finishMatch fehlgeschlagen:', err));
    } else {
      for (const p of Object.values(match.players)) {
        if (p.socketId !== socket.id) io.to(p.socketId).emit('match:opponent-stopped');
      }
    }
  });

  // --- WebRTC-Signaling (für Phase 2, aktuell ungenutzt) ---
  socket.on('webrtc:signal', ({ matchId, targetUserId, data } = {}) => {
    const match = activeMatches.get(matchId);
    if (!match || match.finished || !match.players[socket.data.userId]) return;
    const target = match.players[targetUserId];
    if (target) {
      io.to(target.socketId).emit('webrtc:signal', { fromUserId: socket.data.userId, data });
    }
  });

  // --- Report: nur nach beendetem Match, mit Begründung ---
  socket.on('match:report', async ({ matchId, reasonCode, text } = {}) => {
    const match = activeMatches.get(matchId);
    if (!match || !match.finished) return;
    if (!REPORT_REASONS.has(reasonCode)) return;
    const reporterId = socket.data.userId;
    if (!match.players[reporterId]) return;
    const reportedId = Object.keys(match.players).find((id) => id !== reporterId);
    if (!reportedId) return;

    try {
      await pool.query(
        `INSERT INTO reports (match_id, reporter_id, reported_id, reason_code, reason)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (match_id, reporter_id) DO NOTHING`,
        [matchId, reporterId, reportedId, reasonCode, String(text ?? '').trim().slice(0, 200) || null]
      );
      socket.emit('match:report-received', { matchId });
      await checkReportCluster(reportedId);
    } catch (err) {
      console.error('Report konnte nicht gespeichert werden:', err);
    }
  });

  socket.on('disconnect', () => {
    const userId = socket.data.userId;
    removeSocket(socket.id); // nur diese Verbindung – ein zweites Gerät desselben Kontos bleibt in der Queue

    const matchId = userMatch.get(userId);
    const match = matchId ? activeMatches.get(matchId) : null;
    const me = match?.players[userId];
    if (!match || match.finished || !me || me.socketId !== socket.id) return;

    if (!match.startAt) {
      // Noch nicht gestartet: ohne Wertung abbrechen, damit der Gegner nicht ewig wartet
      abortMatch(matchId, 'opponent_left');
    } else if (!me.stoppedAt) {
      // Nach dem Start zählt Verlassen als Aufgabe. Sonst könnte man jede drohende
      // Niederlage einfach durch Schließen der App ungeschehen machen.
      me.forfeit = true;
      me.stoppedAt = Date.now();
      me.timeMs = DNF_MS;
      finishMatch(matchId).catch((err) => console.error('finishMatch fehlgeschlagen:', err));
    }
    // Wer schon gestoppt hat und dann geht, bekommt sein Ergebnis ganz normal gewertet.
  });
});

// Vergleich der Online-Zeit mit den letzten 20 Solo-Solves des Spielers
async function isSuspicious(userId, category, timeMs) {
  if (!Number.isInteger(timeMs) || timeMs >= DNF_MS) return false; // DNF ist nicht auffällig, sondern einfach ein DNF
  if (timeMs < MIN_ONLINE_MS) return true;
  try {
    const { rows } = await pool.query(
      `SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY time_ms) AS med
         FROM (
           SELECT time_ms FROM solves
            WHERE user_id = $1 AND category = $2 AND NOT is_online AND time_ms < $3
            ORDER BY solved_at DESC LIMIT 20
         ) t`,
      [userId, category, DNF_MS]
    );
    const med = rows[0]?.med == null ? null : Number(rows[0].med);
    return med !== null && timeMs < med * PLAUSIBILITY_FACTOR;
  } catch (err) {
    console.error('Plausibilitätsprüfung fehlgeschlagen:', err);
    return false; // im Zweifel nicht bestrafen
  }
}

async function finishMatch(matchId) {
  const match = activeMatches.get(matchId);
  if (!match || match.finished) return;
  match.finished = true;
  clearMatchTimer(match);

  const [id1, id2] = Object.keys(match.players); // Reihenfolge = player1, player2 aus der Match-Erstellung
  const p1 = match.players[id1];
  const p2 = match.players[id2];
  userMatch.delete(id1);
  userMatch.delete(id2);

  const winnerId = pickWinner(id1, p1, id2, p2);
  const loserId = winnerId === null ? null : winnerId === id1 ? id2 : id1;
  const time1 = Number.isInteger(p1.timeMs) ? p1.timeMs : null; // null = hat nie gestoppt
  const time2 = Number.isInteger(p2.timeMs) ? p2.timeMs : null;

  let ratingChanges = null;
  let flagged = false;
  let client = null;
  try {
    const suspicious = {
      [id1]: await isSuspicious(id1, match.category, time1),
      [id2]: await isSuspicious(id2, match.category, time2),
    };
    flagged = suspicious[id1] || suspicious[id2];

    client = await pool.connect();
    await client.query('BEGIN');

    let changes = null;
    if (flagged) {
      // Auffälliges Match: ungewertet, der auffällige Spieler verliert automatisch Trust
      for (const id of [id1, id2]) {
        if (!suspicious[id]) continue;
        await client.query(
          `UPDATE users SET trust_score = GREATEST(0, trust_score - $2) WHERE id = $1`,
          [id, PLAUSIBILITY_TRUST_PENALTY]
        );
      }
    } else if (winnerId !== null) {
      const { rows } = await client.query(
        `SELECT id, rating FROM users WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE`,
        [[id1, id2]]
      );
      const rating = Object.fromEntries(rows.map((r) => [r.id, r.rating]));
      const delta = eloDelta(rating[winnerId], rating[loserId]);
      const newWinner = Math.max(RATING_FLOOR, rating[winnerId] + delta);
      const newLoser = Math.max(RATING_FLOOR, rating[loserId] - delta);

      // Rating aktualisieren; sauber gespielte Matches erhöhen den Trust Score langsam.
      // Wer aufgibt, bekommt den Bonus nicht.
      await client.query(
        `UPDATE users SET rating = $2, trust_score = LEAST(100, trust_score + 1) WHERE id = $1`,
        [winnerId, newWinner]
      );
      await client.query(
        `UPDATE users SET rating = $2, trust_score = LEAST(100, trust_score + $3) WHERE id = $1`,
        [loserId, newLoser, match.players[loserId].forfeit ? 0 : 1]
      );
      changes = {
        [winnerId]: { delta: newWinner - rating[winnerId], newRating: newWinner },
        [loserId]: { delta: newLoser - rating[loserId], newRating: newLoser },
      };
    }

    for (const [id, p] of [[id1, p1], [id2, p2]]) {
      if (!hasValidTime(p) || suspicious[id]) continue; // DNF und auffällige Zeiten zählen nicht
      await client.query(
        `INSERT INTO solves (user_id, category, time_ms, is_online, match_id)
         VALUES ($1, $2, $3, TRUE, $4)`,
        [id, match.category, p.timeMs, matchId]
      );
    }

    await client.query(
      `UPDATE matches
          SET winner_id = $1, player1_time_ms = $2, player2_time_ms = $3, finished_at = now(), flagged = $5
        WHERE id = $4`,
      [winnerId, time1, time2, matchId, flagged]
    );

    await client.query('COMMIT');
    ratingChanges = changes; // erst nach dem COMMIT gilt die Wertung
  } catch (err) {
    if (client) await client.query('ROLLBACK').catch(() => { });
    console.error('Match-Ergebnis konnte nicht gespeichert werden:', err);
  } finally {
    if (client) client.release();
  }

  for (const p of Object.values(match.players)) {
    io.to(p.socketId).emit('match:result', {
      matchId,
      winnerId,
      times: { [id1]: time1, [id2]: time2 },
      forfeit: { [id1]: !!p1.forfeit, [id2]: !!p2.forfeit },
      ratingChanges,
      unrated: ratingChanges === null,
      flagged,
    });
  }

  // Match noch eine Weile im Speicher lassen, damit Reports möglich bleiben
  setTimeout(() => activeMatches.delete(matchId), MATCH_KEEP_MS).unref();
}

// Matchmaking-Loop: prüft jede Sekunde auf passende Paare
let matching = false;
const matchLoop = setInterval(async () => {
  if (matching) return;
  matching = true;
  try {
    for (const { category, player1, player2 } of findMatches()) {
      // Wer inzwischen weg ist oder schon spielt, wird nicht gematcht; der andere wartet weiter
      const ok1 = io.sockets.sockets.has(player1.socketId) && !userMatch.has(player1.userId);
      const ok2 = io.sockets.sockets.has(player2.socketId) && !userMatch.has(player2.userId);
      if (!ok1 || !ok2 || player1.userId === player2.userId) {
        if (ok1) joinQueue({ ...player1, category });
        else if (ok2) joinQueue({ ...player2, category });
        continue;
      }

      const matchId = crypto.randomUUID();

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

      const scramble = generateScramble(category);
      activeMatches.set(matchId, {
        category,
        scramble,
        players: {
          [player1.userId]: { socketId: player1.socketId, ready: false },
          [player2.userId]: { socketId: player2.socketId, ready: false },
        },
        startAt: null,
        finished: false,
        // bestätigt jemand nicht, hängt der andere sonst für immer im "Bereit"-Bildschirm
        timer: setTimeout(() => abortMatch(matchId, 'ready_timeout'), READY_TIMEOUT_MS),
      });
      userMatch.set(player1.userId, matchId);
      userMatch.set(player2.userId, matchId);

      for (const [me, other] of [[player1, player2], [player2, player1]]) {
        io.to(me.socketId).emit('match:found', {
          matchId,
          category,
          scramble,
          readyTimeoutMs: READY_TIMEOUT_MS,
          opponentUserId: other.userId,
          opponentName: other.username,
          opponentRating: other.rating,
        });
      }
    }
  } catch (err) {
    console.error('Matchmaking-Loop fehlgeschlagen:', err);
  } finally {
    matching = false;
  }
}, 1000);

process.on('unhandledRejection', (err) => console.error('Unbehandelter Fehler:', err));

async function start() {
  // Datenbank-Schema beim Start anlegen bzw. ergänzen. db/schema.sql ist wiederholbar
  // und löscht nichts – dadurch muss niemand das SQL von Hand ausführen.
  try {
    const schema = fs.readFileSync(new URL('./db/schema.sql', import.meta.url), 'utf8');
    await pool.query(schema);
    console.log('Datenbank-Schema ist aktuell.');
  } catch (err) {
    console.error('Datenbank-Schema konnte nicht angewendet werden:', err);
  }
  // Matches, die ein früherer Prozess nicht mehr beenden konnte (Neustart/Deploy), sind verloren
  try {
    await pool.query(`DELETE FROM matches WHERE finished_at IS NULL`);
  } catch (err) {
    console.error('Aufräumen offener Matches fehlgeschlagen:', err);
  }
  const PORT = process.env.PORT || 4000;
  server.listen(PORT, () => console.log(`cube-timer-server läuft auf Port ${PORT}`));
}

// Sauber herunterfahren, damit Render beim Deploy keine halben Transaktionen abschneidet
function shutdown() {
  clearInterval(matchLoop);
  for (const matchId of [...activeMatches.keys()]) abortMatch(matchId, 'server_restart');
  io.close(() => pool.end().finally(() => process.exit(0)));
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

start();
