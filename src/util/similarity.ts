const STOP_WORDS = new Set([
  'the',
  'and',
  'for',
  'with',
  'that',
  'this',
  'are',
  'was',
  'not',
  'when',
  'into',
  'from',
  'then',
  'has',
  'have',
  'its',
]);

/** The meaningful lowercase words of a text: three letters or more, no filler words. */
export function wordsOf(text: string): Set<string> {
  const found = text.toLowerCase().match(/[a-z0-9]{3,}/g) ?? [];
  return new Set(found.filter((word) => !STOP_WORDS.has(word)));
}

/**
 * How alike two texts are, from 0 (nothing shared) to 1 (same words).
 * A rough measure of wording, not of meaning.
 */
export function similarity(a: string, b: string): number {
  const left = wordsOf(a);
  const right = wordsOf(b);
  if (left.size === 0 || right.size === 0) return 0;

  let shared = 0;
  for (const word of left) if (right.has(word)) shared++;
  return shared / (left.size + right.size - shared);
}
