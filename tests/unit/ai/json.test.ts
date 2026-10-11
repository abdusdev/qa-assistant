import { describe, expect, it } from 'vitest';
import { extractJson, JsonExtractionError } from '../../../src/ai/json.js';

describe('extractJson', () => {
  it('reads a clean JSON answer', () => {
    expect(extractJson('{"cases":[{"id":"TC-1"}]}')).toEqual({ cases: [{ id: 'TC-1' }] });
  });

  it('ignores whitespace around the answer', () => {
    expect(extractJson('\n  {"ok":true}  \n')).toEqual({ ok: true });
  });

  it('reads JSON inside a markdown code fence with a language tag', () => {
    const answer = 'Here you go:\n```json\n{"ok":true}\n```\nHope that helps.';
    expect(extractJson(answer)).toEqual({ ok: true });
  });

  it('prefers the fenced block when text with braces comes before it', () => {
    const answer = 'Use the {cases} format like this:\n```json\n{"ok":true}\n```\nDone {thanks}.';
    expect(extractJson(answer)).toEqual({ ok: true });
  });

  it('reads JSON inside a plain code fence', () => {
    expect(extractJson('```\n{"ok":true}\n```')).toEqual({ ok: true });
  });

  it('reads JSON surrounded by chatter', () => {
    expect(extractJson('Sure! {"ok":true,"n":{"deep":1}} Let me know.')).toEqual({
      ok: true,
      n: { deep: 1 },
    });
  });

  it('keeps braces that appear inside strings', () => {
    expect(extractJson('{"title":"Handles {curly} text"}')).toEqual({
      title: 'Handles {curly} text',
    });
  });

  it('rejects an empty answer', () => {
    expect(() => extractJson('   ')).toThrow(JsonExtractionError);
    expect(() => extractJson('   ')).toThrow(/empty/);
  });

  it('rejects an answer with no JSON in it', () => {
    expect(() => extractJson('I cannot help with that.')).toThrow(/not valid JSON/);
  });

  it('rejects broken JSON', () => {
    expect(() => extractJson('{"cases": [')).toThrow(/not valid JSON/);
    expect(() => extractJson('{"cases": [1, 2,]}')).toThrow(/not valid JSON/);
  });
});
