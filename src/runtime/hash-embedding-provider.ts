import type { EmbeddingProvider } from "./embedding-runner.ts";

const DEFAULT_DIMENSIONS = 1536;
const DEFAULT_MODEL = "archon-local-hash-1536";

export interface HashEmbeddingProviderOptions {
  dimensions?: number | undefined;
  model?: string | undefined;
}

export function createHashEmbeddingProvider(options: HashEmbeddingProviderOptions = {}): EmbeddingProvider {
  const dimensions = normalizeDimensions(options.dimensions);
  const supportedModel = options.model?.trim() || DEFAULT_MODEL;

  return {
    async embed(input) {
      return hashTextToEmbedding(input.text, {
        dimensions: resolveDimensionsForModel(input.model, dimensions, supportedModel)
      });
    },
    async embedQuery(input) {
      return hashTextToEmbedding(input.text, {
        dimensions: resolveDimensionsForModel(input.model, dimensions, supportedModel)
      });
    }
  };
}

export function hashTextToEmbedding(
  text: string,
  options: { dimensions?: number | undefined } = {}
): readonly number[] {
  const dimensions = normalizeDimensions(options.dimensions);
  const vector = new Array<number>(dimensions).fill(0);
  const tokens = tokenize(text);

  if (tokens.length === 0) {
    return vector;
  }

  for (const token of tokens) {
    const unsignedHash = fnv1a(token);
    const bucket = unsignedHash % dimensions;
    const sign = (unsignedHash & 1) === 0 ? 1 : -1;
    const weight = 1 + ((unsignedHash >>> 1) % 7) / 10;
    vector[bucket] = (vector[bucket] ?? 0) + sign * weight;
  }

  return normalizeVector(vector);
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

function fnv1a(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function normalizeVector(vector: readonly number[]): readonly number[] {
  const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  if (!Number.isFinite(magnitude) || magnitude === 0) {
    return vector.map(() => 0);
  }

  return vector.map((value) => Number((value / magnitude).toFixed(12)));
}

function normalizeDimensions(candidate?: number | undefined): number {
  if (!candidate) {
    return DEFAULT_DIMENSIONS;
  }

  if (!Number.isInteger(candidate) || candidate <= 0) {
    throw new Error(`invalid embedding dimensions: ${candidate}`);
  }

  return candidate;
}

function resolveDimensionsForModel(model: string, fallback: number, supportedModel: string): number {
  if (model.trim() === supportedModel) {
    return fallback;
  }

  if (model.trim().endsWith("-1536")) {
    return DEFAULT_DIMENSIONS;
  }

  return fallback;
}
