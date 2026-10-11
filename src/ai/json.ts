/** Thrown when an AI answer cannot be read as JSON. The message is safe to show. */
export class JsonExtractionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JsonExtractionError';
  }
}

function tryParse(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

/**
 * Reads JSON out of an AI answer. Handles a clean answer, an answer wrapped in a
 * markdown code fence, and an answer with chatter before or after the JSON.
 */
export function extractJson(answer: string): unknown {
  const trimmed = answer.trim();
  if (trimmed === '') {
    throw new JsonExtractionError('The answer is empty.');
  }

  const whole = tryParse(trimmed);
  if (whole.ok) return whole.value;

  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  if (fenced?.[1]) {
    const inside = tryParse(fenced[1].trim());
    if (inside.ok) return inside.value;
  }

  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start !== -1 && end > start) {
    const slice = tryParse(trimmed.slice(start, end + 1));
    if (slice.ok) return slice.value;
  }

  throw new JsonExtractionError('The answer is not valid JSON.');
}
