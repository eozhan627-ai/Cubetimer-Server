-- Schema für den cube-timer-server. Auf der Render-Postgres-DB ausführen.
-- Das Skript ist wiederholbar: es legt Fehlendes an und ergänzt ältere Datenbanken,
-- ohne vorhandene Daten zu löschen.

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ---------- users ----------
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username TEXT UNIQUE NOT NULL,
  auth_token_hash TEXT,              -- SHA-256 des Geräte-Tokens (anonyme Konten)
  rating INTEGER NOT NULL DEFAULT 1200,
  trust_score INTEGER NOT NULL DEFAULT 100,
  is_vip BOOLEAN NOT NULL DEFAULT FALSE,
  online_banned_until TIMESTAMPTZ,   -- vorläufige Online-Sperre nach gehäuften Meldungen
  recovery_code_hash TEXT,           -- SHA-256 des Wiederherstellungscodes (Kontosicherung)
  matches_played INTEGER NOT NULL DEFAULT 0, -- gewertete Online-Matches
  wins INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE users ADD COLUMN IF NOT EXISTS auth_token_hash TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS online_banned_until TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS recovery_code_hash TEXT;

-- Die erste Version verlangte E-Mail und Passwort. Anonyme Konten haben beides nicht.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_name = 'users' AND column_name = 'email') THEN
    ALTER TABLE users ALTER COLUMN email DROP NOT NULL;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_name = 'users' AND column_name = 'password_hash') THEN
    ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;
  END IF;
END $$;

-- ---------- matches ----------
CREATE TABLE IF NOT EXISTS matches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  category TEXT NOT NULL,
  player1_id UUID NOT NULL REFERENCES users(id),
  player2_id UUID NOT NULL REFERENCES users(id),
  winner_id UUID REFERENCES users(id),   -- NULL = kein Gewinner (z. B. beide DNF)
  player1_time_ms INTEGER,               -- NULL = nie gestoppt, 999999999 = DNF
  player2_time_ms INTEGER,
  flagged BOOLEAN NOT NULL DEFAULT FALSE, -- Plausibilitätsprüfung hat angeschlagen -> ungewertet
  player1_rating_delta INTEGER,          -- Rating-Änderung durch dieses Match (NULL = ungewertet)
  player2_rating_delta INTEGER,
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE matches ADD COLUMN IF NOT EXISTS flagged BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE matches ADD COLUMN IF NOT EXISTS player1_rating_delta INTEGER;
ALTER TABLE matches ADD COLUMN IF NOT EXISTS player2_rating_delta INTEGER;

-- Zähler für Profil und Rangliste. Beim ersten Anlegen werden sie einmalig aus den
-- bisherigen Matches berechnet (alte Matches haben keine Rating-Änderung gespeichert,
-- deshalb zählen dort alle unauffälligen Matches mit Gewinner).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_name = 'users' AND column_name = 'matches_played') THEN
    ALTER TABLE users ADD COLUMN matches_played INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE users ADD COLUMN wins INTEGER NOT NULL DEFAULT 0;
    UPDATE users u SET
      matches_played = (SELECT COUNT(*) FROM matches m
                         WHERE m.finished_at IS NOT NULL AND NOT m.flagged AND m.winner_id IS NOT NULL
                           AND (m.player1_id = u.id OR m.player2_id = u.id)),
      wins = (SELECT COUNT(*) FROM matches m
               WHERE m.finished_at IS NOT NULL AND NOT m.flagged AND m.winner_id = u.id);
  END IF;
END $$;

-- ---------- solves ----------
CREATE TABLE IF NOT EXISTS solves (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  category TEXT NOT NULL,
  time_ms INTEGER NOT NULL,
  is_online BOOLEAN NOT NULL DEFAULT FALSE,
  match_id UUID,
  solved_at TIMESTAMPTZ NOT NULL DEFAULT now(), -- Zeitpunkt des Solves auf dem Gerät
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE solves ADD COLUMN IF NOT EXISTS solved_at TIMESTAMPTZ NOT NULL DEFAULT now();

-- ---------- reports ----------
CREATE TABLE IF NOT EXISTS reports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  match_id UUID NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  reporter_id UUID NOT NULL REFERENCES users(id),
  reported_id UUID NOT NULL REFERENCES users(id),
  reason_code TEXT,                       -- no_stop | instant_stop | other
  reason TEXT,                            -- optionaler Freitext
  video_url TEXT,
  status TEXT NOT NULL DEFAULT 'pending', -- pending | reviewed_valid | reviewed_invalid
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE reports ADD COLUMN IF NOT EXISTS reason_code TEXT;

-- ---------- Indizes ----------
CREATE INDEX IF NOT EXISTS idx_solves_user ON solves(user_id);
-- Derselbe Solo-Solve darf nur einmal zählen (der Upload wird bei Netzproblemen wiederholt)
CREATE UNIQUE INDEX IF NOT EXISTS idx_solves_solo_unique
  ON solves(user_id, category, solved_at) WHERE NOT is_online;
CREATE INDEX IF NOT EXISTS idx_users_leaderboard ON users(rating DESC) WHERE matches_played > 0;
CREATE INDEX IF NOT EXISTS idx_matches_player2 ON matches(player2_id);
CREATE INDEX IF NOT EXISTS idx_matches_players ON matches(player1_id, player2_id);
CREATE INDEX IF NOT EXISTS idx_matches_unfinished ON matches(created_at) WHERE finished_at IS NULL;
-- Pro Match kann jeder Spieler den Gegner nur einmal melden
CREATE UNIQUE INDEX IF NOT EXISTS idx_reports_match_reporter ON reports(match_id, reporter_id);
CREATE INDEX IF NOT EXISTS idx_reports_status ON reports(status);
CREATE INDEX IF NOT EXISTS idx_reports_reported ON reports(reported_id, created_at);
