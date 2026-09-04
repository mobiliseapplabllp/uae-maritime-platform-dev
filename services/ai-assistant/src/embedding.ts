/* The dense half of retrieval: a fixed-width vector per passage, computed here and stored in pgvector.
 *
 * What it is. Each document is projected into 256 dimensions by hashing the character trigrams of its own
 * tokens. That is a lexical signal, not a semantic one — it will not bring "vessel detained" and "ship held
 * at berth" together, and this file does not pretend otherwise. What it does bring together is everything
 * the word-level index misses because a word-level index compares whole tokens: a misspelling, a
 * transliteration ("Al Mansoori" against "Al-Mansouri"), an inflection the crude stemmer does not reach, a
 * partial reference (MAR/LIC/2026 against MAR/LIC/2026/0031), and Arabic morphology, where the English
 * stemmer does nothing at all. The two halves fail differently, which is the only reason to have both.
 *
 * Why it is shaped like this. The vector is document-local: it depends on the document's own text and on
 * nothing else in the corpus. The tf-idf vectors are not — every document frequency changes when a passage
 * is added, so that index has to be rebuilt whole. A document-local vector can be embedded once, written
 * once, and left alone, which is what makes an ANN index over the corpus maintainable rather than something
 * that has to be dropped and rebuilt on every write.
 *
 * And it is the slot a real model drops into. When a hosted embedding model is available inside the
 * jurisdiction, the change is this file and the dimension constant: the column, the index, the permission
 * filter, the recall stage and the re-ranking all stay exactly as they are. */

/** Dimensions of the dense vector. Changing this is a migration, not a configuration change: the stored
 *  column is declared at this width and pgvector will reject anything else. */
export const EMBED_DIM = 256;

/** Trigram cosine below this is background overlap between two pieces of English, not a match, so it is
 *  discounted to nothing rather than allowed to lift an unrelated passage over the score floor. */
export const DENSE_FLOOR = 0.15;

/**
 * What the fuzzy half must score to retrieve a passage on its own, with no word in common with the question.
 *
 * Discounting the background is not enough on a real corpus. Trigrams are not weighted by how common they
 * are — that is the price of a document-local vector — so a long word will always find some document that
 * happens to share its endings: `frobnicate` and `certificate` have four trigrams in common and nothing
 * else. Across a few hundred passages one of those coincidences will always clear the floor, and the
 * assistant would answer a nonsense question by citing whichever passage won the coincidence.
 *
 * So the fuzzy half rescues, it does not retrieve. A passage that also matches a word is ranked on the
 * blend of both; a passage that matches no word at all is a hit only on a resemblance far too strong to be
 * a coincidence of endings — a misspelling of the passage's own vocabulary, which is what this is for.
 */
export const DENSE_ONLY_MIN = 0.35;

/** FNV-1a, 32-bit, with a seed so two independent values can be drawn from one string. */
export function fnv1a(text: string, seed = 0x811c9dc5): number {
  let h = seed >>> 0;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i) & 0xff;
    h = Math.imul(h, 0x01000193) >>> 0;
    // characters outside Latin-1 (Arabic, above all) carry their high byte too, or every one of them
    // would hash to the same bucket
    const hi = text.charCodeAt(i) >>> 8;
    if (hi) { h ^= hi; h = Math.imul(h, 0x01000193) >>> 0; }
  }
  return h >>> 0;
}

/** Character trigrams of one token, bounded so a prefix and a suffix are grams in their own right:
 *  `bunker` gives `#bu bun unk nke ker er#`, which is what lets `bunkerng` still match it. */
export function trigrams(token: string): string[] {
  const padded = `#${token}#`;
  if (padded.length <= 3) return [padded];
  const out: string[] = [];
  for (let i = 0; i + 3 <= padded.length; i++) out.push(padded.slice(i, i + 3));
  return out;
}

/** Counts of every trigram across a token stream. The stream is already stop-word filtered and stemmed by
 *  the tokeniser, so the commonest grams of English prose are not in it to swamp everything else. */
export function gramCounts(tokens: readonly string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const token of tokens) for (const g of trigrams(token)) counts[g] = (counts[g] ?? 0) + 1;
  return counts;
}

/**
 * Signed feature hashing into a fixed width. Two independent hashes of the same gram give the bucket and the
 * sign; the sign is what keeps collisions from accumulating — two unrelated grams landing in one bucket are
 * as likely to cancel as to reinforce, so the dot product stays an unbiased estimate of the true overlap.
 *
 * Weights are sub-linear in count and the result is L2-normalised, so a long passage does not outrank a
 * short one merely for being long, and a dot product of two vectors is their cosine.
 */
export function hashVector(counts: Record<string, number>): number[] {
  const v = new Float64Array(EMBED_DIM);
  for (const [gram, count] of Object.entries(counts)) {
    const h = fnv1a(gram);
    const sign = fnv1a(gram, 0x9e3779b1) & 1 ? 1 : -1;
    v[h % EMBED_DIM] += sign * (1 + Math.log(count));
  }
  let sum = 0;
  for (const x of v) sum += x * x;
  const n = Math.sqrt(sum);
  if (!n) return [];
  // rounded, so the same text embeds to the same 256 numbers on every machine and in every process
  return Array.from(v, (x) => Math.round((x / n) * 1e6) / 1e6);
}

/** The dense vector for an already-tokenised passage. An empty result means there was nothing to embed. */
export const embedTokens = (tokens: readonly string[]): number[] => (tokens.length ? hashVector(gramCounts(tokens)) : []);

/** Cosine of two L2-normalised dense vectors, which is their dot product. Mismatched or absent vectors
 *  score nothing rather than throwing: a corpus written before this column existed simply has no dense half. */
export function denseCosine(a: readonly number[], b: readonly number[]): number {
  if (a.length !== EMBED_DIM || b.length !== EMBED_DIM) return 0;
  let dot = 0;
  for (let i = 0; i < EMBED_DIM; i++) dot += a[i] * b[i];
  return Math.round(dot * 1e6) / 1e6;
}

/** The dense score after the background overlap is taken out, rescaled so it still spans 0..1. */
export function denseContribution(similarity: number): number {
  if (similarity <= DENSE_FLOOR) return 0;
  return Math.round(((similarity - DENSE_FLOOR) / (1 - DENSE_FLOOR)) * 1e6) / 1e6;
}

/** The wire form pgvector parses: `[0.1,-0.2,...]`. */
export const toVectorLiteral = (v: readonly number[]) => `[${v.join(',')}]`;
