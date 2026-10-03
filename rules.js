// Reine Spielregeln ohne DB/Netzwerk – dadurch einzeln testbar.

export const DNF_MS = 999999999;
export const K_FACTOR = 32;

export function eloDelta(winnerRating, loserRating) {
  const expected = 1 / (1 + Math.pow(10, (loserRating - winnerRating) / 400));
  return Math.round(K_FACTOR * (1 - expected));
}

export const hasValidTime = (p) => Number.isInteger(p.timeMs) && p.timeMs < DNF_MS;

// Gewinner bestimmen. null = kein Gewinner (beide DNF, beide weg oder exakt gleiche Zeit).
export function pickWinner(id1, p1, id2, p2) {
  if (!!p1.forfeit !== !!p2.forfeit) return p1.forfeit ? id2 : id1;
  if (p1.forfeit) return null;
  const v1 = hasValidTime(p1);
  const v2 = hasValidTime(p2);
  if (v1 && v2) return p1.timeMs === p2.timeMs ? null : p1.timeMs < p2.timeMs ? id1 : id2;
  if (v1) return id1;
  if (v2) return id2;
  return null;
}

// Einfacher Zähler pro Schlüssel und Zeitfenster (reicht für eine einzelne Server-Instanz)
export function createLimiter({ windowMs, max }) {
  const hits = new Map(); // key -> { count, resetAt }
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [key, h] of hits) if (h.resetAt <= now) hits.delete(key);
  }, windowMs);
  sweep.unref();

  return function allow(key, now = Date.now()) {
    const h = hits.get(key);
    if (!h || h.resetAt <= now) {
      hits.set(key, { count: 1, resetAt: now + windowMs });
      return true;
    }
    h.count += 1;
    return h.count <= max;
  };
}
