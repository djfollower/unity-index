// Day 5 Task 4: tiny subsequence fuzzy matcher. No new dependency — Day 0.A
// bundle budget is tight and a single-purpose matcher costs ~40 lines. The
// algorithm is the classic subsequence scorer: each haystack char must
// appear in order in the needle, with bonuses for contiguous runs and word-
// boundary hits (slash, dot, dash, underscore, camel-case).
//
// Score range: 0 = no match, >0 = match (higher is better). Callers should
// treat any non-zero return as a hit.

const WORD_BOUNDARY = new Set([' ', '/', '\\', '.', '-', '_', ':']);

export function fuzzyScore(needle: string, haystack: string): number {
  if (needle.length === 0) return 1;
  if (haystack.length === 0) return 0;
  const n = needle.toLowerCase();
  const h = haystack.toLowerCase();

  let score = 0;
  let hi = 0;
  let lastMatch = -2;
  let streak = 0;

  for (let ni = 0; ni < n.length; ni++) {
    const c = n[ni];
    let found = -1;
    for (let i = hi; i < h.length; i++) {
      if (h[i] === c) {
        found = i;
        break;
      }
    }
    if (found === -1) return 0;

    let charScore = 1;
    if (found === lastMatch + 1) {
      streak++;
      charScore += streak; // contiguous run bonus
    } else {
      streak = 0;
    }
    const prev = haystack[found - 1];
    if (found === 0 || (prev !== undefined && WORD_BOUNDARY.has(prev))) {
      charScore += 3; // word-boundary bonus
    } else {
      const here = haystack[found];
      if (
        prev !== undefined &&
        here !== undefined &&
        prev === prev.toLowerCase() &&
        here !== here.toLowerCase()
      ) {
        charScore += 2; // camelCase boundary
      }
    }
    score += charScore;
    lastMatch = found;
    hi = found + 1;
  }

  // Shorter haystacks rank higher when scores tie — keeps "Player.cs" above
  // "PlayerControllerExtensions.cs" for the query "player".
  return score + Math.max(0, 10 - haystack.length / 4);
}

export function fuzzyMatches(needle: string, haystack: string): boolean {
  return fuzzyScore(needle, haystack) > 0;
}
