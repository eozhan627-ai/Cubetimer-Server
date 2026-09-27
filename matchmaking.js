// Einfache In-Memory-Queue. Reicht für den Start; bei mehreren Server-Instanzen
// später durch Redis ersetzen, damit alle Instanzen dieselbe Queue sehen.

const queues = new Map(); // category -> [{ socketId, userId, rating, joinedAt }]

const RATING_WINDOW_START = 100; // anfängliche Toleranz
const RATING_WINDOW_GROWTH = 50; // wächst pro 5s Wartezeit, damit man nicht ewig wartet

function getQueue(category) {
  if (!queues.has(category)) queues.set(category, []);
  return queues.get(category);
}

export function joinQueue({ socketId, userId, category, rating }) {
  const queue = getQueue(category);
  // falls schon drin (Reconnect o.ä.), zuerst entfernen
  removeFromQueues(userId);
  queue.push({ socketId, userId, rating, joinedAt: Date.now() });
}

export function removeFromQueues(userId) {
  for (const queue of queues.values()) {
    const idx = queue.findIndex((p) => p.userId === userId);
    if (idx !== -1) queue.splice(idx, 1);
  }
}

export function removeSocket(socketId) {
  for (const queue of queues.values()) {
    const idx = queue.findIndex((p) => p.socketId === socketId);
    if (idx !== -1) queue.splice(idx, 1);
  }
}

// Sucht in jeder Kategorie-Queue nach passenden Paaren und gibt sie zurück.
// Wird regelmäßig (z. B. alle 1s) vom Server aufgerufen.
export function findMatches() {
  const matches = [];

  for (const [category, queue] of queues.entries()) {
    queue.sort((a, b) => a.joinedAt - b.joinedAt);

    const matched = new Set();

    for (let i = 0; i < queue.length; i++) {
      if (matched.has(queue[i].userId)) continue;

      for (let j = i + 1; j < queue.length; j++) {
        if (matched.has(queue[j].userId)) continue;

        const waitMs = Date.now() - queue[i].joinedAt;
        const window =
          RATING_WINDOW_START + Math.floor(waitMs / 5000) * RATING_WINDOW_GROWTH;

        if (Math.abs(queue[i].rating - queue[j].rating) <= window) {
          matches.push({ category, player1: queue[i], player2: queue[j] });
          matched.add(queue[i].userId);
          matched.add(queue[j].userId);
          break;
        }
      }
    }

    queues.set(
      category,
      queue.filter((p) => !matched.has(p.userId))
    );
  }

  return matches;
}