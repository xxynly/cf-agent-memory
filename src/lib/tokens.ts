/**
 * Language-agnostic tokenizer for the keyword channel.
 *
 * Why not a real tokenizer: Workers has no ICU and jieba-class segmenters are
 * heavy WASM payloads. For recall over short memory snippets, CJK bigrams plus
 * latin words is within a few points of proper segmentation and costs nothing.
 *
 * The same function runs at write time and at query time, so both sides of the
 * index agree on tokens (this is the classic mistake that silently kills recall).
 */

const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/;
const LATIN = /[a-z0-9][a-z0-9._\-/:]{1,}/g;

export function tokenize(text: string): string[] {
  if (!text) return [];
  const normalized = text.toLowerCase().normalize("NFKC");
  const out = new Set<string>();

  for (const match of normalized.matchAll(LATIN)) {
    out.add(match[0]);
  }

  const chars = [...normalized];
  let run: string[] = [];
  const flush = () => {
    if (run.length === 1) out.add(run[0]);
    for (let i = 0; i + 1 < run.length; i++) out.add(run[i] + run[i + 1]);
    run = [];
  };

  for (const ch of chars) {
    if (CJK.test(ch)) {
      run.push(ch);
    } else {
      if (run.length) flush();
    }
  }
  if (run.length) flush();

  return [...out];
}

/** Serialized form stored in D1 and indexed by FTS5. */
export function tokensToText(tokens: string[]): string {
  return tokens.join(" ");
}

/** Builds a safe FTS5 MATCH expression: every token quoted, joined by OR. */
export function buildFtsQuery(tokens: string[]): string {
  if (tokens.length === 0) return "";
  return tokens
    .slice(0, 32)
    .map((t) => `"${t.replace(/"/g, '""')}"`)
    .join(" OR ");
}
