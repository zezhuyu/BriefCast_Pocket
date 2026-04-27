const LOCAL_DIMENSION = 256;

function hashToken(token: string): number {
  let h = 2166136261;
  for (let i = 0; i < token.length; i += 1) {
    h ^= token.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function normalize(vec: number[]): number[] {
  const norm = Math.sqrt(vec.reduce((sum, v) => sum + v * v, 0));
  if (!norm) {
    return vec;
  }
  return vec.map((v) => v / norm);
}

export function localEmbedText(text: string): number[] {
  const vec = new Array<number>(LOCAL_DIMENSION).fill(0);
  const tokens = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1);

  for (const token of tokens) {
    const h = hashToken(token);
    const index = h % LOCAL_DIMENSION;
    const sign = h % 2 === 0 ? 1 : -1;
    vec[index] += sign * (1 + Math.log1p(token.length));
  }

  return normalize(vec);
}

export function cosineSimilarity(a: number[], b: number[]): number {
  const length = Math.min(a.length, b.length);
  if (!length) {
    return 0;
  }

  let dot = 0;
  let aNorm = 0;
  let bNorm = 0;

  for (let i = 0; i < length; i += 1) {
    dot += a[i] * b[i];
    aNorm += a[i] * a[i];
    bNorm += b[i] * b[i];
  }

  if (!aNorm || !bNorm) {
    return 0;
  }

  return dot / Math.sqrt(aNorm * bNorm);
}
