import { describe, expect, it } from 'vitest';
import { fuzzyMatches, fuzzyScore } from '../fuzzy';

describe('fuzzyScore', () => {
  it('empty query is a universal match', () => {
    expect(fuzzyScore('', 'whatever')).toBeGreaterThan(0);
  });

  it('returns 0 for impossible matches', () => {
    expect(fuzzyScore('xyz', 'abc')).toBe(0);
  });

  it('matches subsequences', () => {
    expect(fuzzyMatches('plyr', 'PlayerController')).toBe(true);
  });

  it('ranks exact substring above scattered subsequence', () => {
    const exact = fuzzyScore('player', 'PlayerController');
    const scattered = fuzzyScore('player', 'PrlrcExtensionalThruway'); // p,l,y,e,r out of order? all in order
    expect(exact).toBeGreaterThan(scattered);
  });

  it('rewards word-boundary hits over mid-word hits at same haystack length', () => {
    // Same-length haystacks so the length bonus cancels — the boundary bonus
    // is the only differentiator. The matcher is greedy (first occurrence
    // wins) so the test inputs are crafted to land on the intended position.
    const boundary = fuzzyScore('p', '/player.cs');
    const midWord = fuzzyScore('p', 'sample.txt');
    expect(boundary).toBeGreaterThan(midWord);
  });

  it('rewards camelCase boundaries', () => {
    const camel = fuzzyScore('c', 'PlayerController.cs');
    const lower = fuzzyScore('c', 'aacharacter.cs');
    expect(camel).toBeGreaterThan(lower);
  });

  it('shorter haystacks beat longer ones at equal-ish scores', () => {
    const short = fuzzyScore('player', 'Player.cs');
    const long = fuzzyScore('player', 'PlayerControllerExtensions.cs');
    expect(short).toBeGreaterThan(long);
  });
});
