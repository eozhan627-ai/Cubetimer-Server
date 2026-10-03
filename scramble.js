// Scramble-Generator (Zufallszüge). Beide Spieler eines Matches bekommen denselben Scramble vom Server.
import crypto from 'crypto';

const FACES = [['U', 'D'], ['R', 'L'], ['F', 'B']]; // je Achse zwei gegenüberliegende Seiten
const SUFFIXES = ['', "'", '2'];
const LENGTHS = { 2: 10, 3: 20, 4: 40, 5: 60, 6: 80, 7: 100 };

export function cubeSize(category) {
  const m = /^(\d+)×(\d+)/.exec(String(category));
  return m && m[1] === m[2] ? Number(m[1]) : null;
}

function moveName(face, depth) {
  if (depth === 1) return face;
  if (depth === 2) return `${face}w`;
  return `${depth}${face}w`;
}

export function generateScramble(category) {
  const n = cubeSize(category);
  if (!n || n < 2) return null;

  const length = LENGTHS[n] ?? 120;
  const maxDepth = Math.max(1, Math.floor(n / 2));
  // 2×2: nur U, R, F – die Gegenseiten wären dieselben Züge
  const facesPerAxis = n === 2 ? 1 : 2;

  const moves = [];
  let lastAxis = -1;
  let usedOnAxis = new Set(); // Züge seit dem letzten Achsenwechsel

  while (moves.length < length) {
    const axis = crypto.randomInt(3);
    const face = FACES[axis][crypto.randomInt(facesPerAxis)];
    const depth = n === 2 ? 1 : 1 + crypto.randomInt(maxDepth);
    const key = `${face}${depth}`;

    if (axis === lastAxis) {
      // gleiche Achse: nie denselben Zug doppelt und höchstens zwei Züge hintereinander
      if (usedOnAxis.has(key) || usedOnAxis.size >= 2) continue;
    } else {
      usedOnAxis = new Set();
      lastAxis = axis;
    }
    usedOnAxis.add(key);
    moves.push(moveName(face, depth) + SUFFIXES[crypto.randomInt(3)]);
  }
  return moves.join(' ');
}
