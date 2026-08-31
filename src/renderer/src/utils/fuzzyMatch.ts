// src/renderer/src/utils/fuzzyMatch.ts
// Hand-rolled subsequence fuzzy matcher for the Todo issue picker's search box.
//
// No fuzzy-matching library exists anywhere in this codebase (verified against package.json and
// src/ before writing this) -- see the tactical plan's "Candidate filtering" decision. This is a
// deliberate upgrade over TodoPicker.tsx's plain substring `.includes()`, not a copy of it.

export interface FuzzyMatchResult {
  /** True when every character of the query appears in the text, in order (a subsequence match). */
  matched: boolean;
  /**
   * Higher is a better match. Only meaningful when `matched` is true -- rewards contiguous runs
   * and matches that start earlier in the text, the way a command-palette filter ranks results.
   */
  score: number;
}

/**
 * Command-palette-style fuzzy match: `query` must appear as a subsequence of `text`
 * (case-insensitive). An empty query matches everything with a score of 0.
 */
export function fuzzyMatch(query: string, text: string): FuzzyMatchResult {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) {
    return { matched: true, score: 0 };
  }

  const haystack = text.toLowerCase();
  let needleIndex = 0;
  let runLength = 0;
  let score = 0;

  for (let i = 0; i < haystack.length && needleIndex < needle.length; i++) {
    if (haystack[i] === needle[needleIndex]) {
      runLength += 1;
      // Contiguous runs score super-linearly, so "abc" beats "a-b-c" against the same query.
      score += 1 + runLength;
      // An earlier match position scores a small bonus, the way VS Code's palette favors
      // matches near the start of the string over the same match found deep inside it.
      score += Math.max(0, 20 - i) * 0.1;
      needleIndex += 1;
    } else {
      runLength = 0;
    }
  }

  const matched = needleIndex === needle.length;
  return { matched, score: matched ? score : 0 };
}
