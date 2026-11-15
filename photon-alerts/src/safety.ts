// Hard rule shared with the Python agent: never tell anyone their water is "safe".
// Every outgoing text passes through scrub() as a last gate.
const PHRASES: [RegExp, string][] = [
  [/\b(?:is|are|looks?|seems?)\s+(?:perfectly\s+|totally\s+|completely\s+|now\s+)?safe(?:\s+to\s+drink)?\b/gi, "is within normal range"],
  [/\b(?:it'?s|that'?s|water'?s)\s+(?:perfectly\s+|totally\s+|now\s+)?safe(?:\s+to\s+drink)?\b/gi, "it's within normal range"],
  [/\bsafe\s+to\s+drink\b/gi, "within normal range"],
  [/\bsafe\s+range\b/gi, "normal range"],
  [/\bsafety\b/gi, "water quality"],
  [/\bsafely\b/gi, "with care"],
  [/\bverdict\s+SAFE\b/g, "verdict: within normal range"],
];
const BARE = /(?<![A-Za-z])(?<!un)safe\b/gi;

export function scrub(text: string): string {
  let out = text;
  for (const [re, repl] of PHRASES) out = out.replace(re, repl);
  return out.replace(BARE, "within normal range");
}

export function violates(text: string): boolean {
  return /(?<![A-Za-z])(?<!un)safe\b/i.test(text) || /\bsafe(ly|ty)\b/i.test(text);
}
