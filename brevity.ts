import type { BrevityLevel } from './presets';

/**
 * Output brevity directives appended to the rendered system prompt
 * (onPromptTemplate, event.name === 'system-prompt').
 *
 * Migrated from savemytoken (S8) and inspired by JuliusBrussee/caveman (MIT):
 * compress the prose style, never the technical substance - code, commands,
 * file paths, error messages, and numbers stay byte-exact.
 *
 * Kept deliberately compact because the directive itself is sent with the
 * system prompt on every model call. Broke never invents or reports token
 * savings for output brevity (Principle #7: no counterfactual output guess).
 */
const DIRECTIVES: Record<Exclude<BrevityLevel, 'off'>, string> = {
  lite: `## Answer style: concise
- No filler, no polite openers, no restating the question.
- Keep code, commands, file paths, and error messages byte-exact.`,
  full: `## Answer style: terse
- Drop filler words, polite openers, restatements, and redundant explanations.
- Use short sentences and fragments where meaning stays clear.
- One idea per line. No preamble like "I'll do X" — just do it.
- Keep code, commands, file paths, error messages, and numbers byte-exact. Never abbreviate or paraphrase them.
- Match the user's language.
- No summary of your work unless asked.`,
  ultra: `## Answer style: telegraphic
- As terse as possible: sentence fragments, omit articles and conjunctions where grammatical.
- Use complete sentences only when needed for clarity.
- Keep code, commands, file paths, error messages, and numbers byte-exact. Never abbreviate or paraphrase them.
- Match the user's language.`,
};

export function buildBrevityDirective(level: BrevityLevel): string {
  if (level === 'off') return '';
  return DIRECTIVES[level];
}
