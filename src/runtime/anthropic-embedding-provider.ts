import process from "node:process";
import type { EmbeddingProvider } from "./embedding-runner.ts";

const DEFAULT_EMBEDDING_MODEL = "voyage-3";
const VOYAGE_API_URL = "https://api.anthropic.com/v1/embeddings";
const MAX_BATCH_SIZE = 128;

export interface AnthropicEmbeddingClientLike {
  createEmbeddings(input: {
    model: string;
    input: string[];
  }): Promise<{ embeddings: ReadonlyArray<{ embedding: readonly number[] }> }>;
}

export interface AnthropicEmbeddingProviderOptions {
  apiKey?: string | undefined;
  model?: string | undefined;
  client?: AnthropicEmbeddingClientLike | undefined;
}

export class HttpAnthropicEmbeddingClient implements AnthropicEmbeddingClientLike {
  private readonly apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  async createEmbeddings(input: {
    model: string;
    input: string[];
  }): Promise<{ embeddings: ReadonlyArray<{ embedding: readonly number[] }> }> {
    const response = await fetch(VOYAGE_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: input.model,
        input: input.input
      })
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "(unreadable)");
      throw new Error(
        `Anthropic embeddings API returned ${response.status}: ${body.slice(0, 200)}`
      );
    }

    const data: unknown = await response.json();
    return parseEmbeddingsResponse(data);
  }
}

function parseEmbeddingsResponse(data: unknown): {
  embeddings: ReadonlyArray<{ embedding: readonly number[] }>;
} {
  if (
    typeof data !== "object" ||
    data === null ||
    !("data" in data) ||
    !Array.isArray((data as Record<string, unknown>)["data"])
  ) {
    throw new Error("Anthropic embeddings API returned an unexpected response shape");
  }

  const items = (data as { data: unknown[] })["data"];
  const embeddings = items.map((item, index) => {
    if (
      typeof item !== "object" ||
      item === null ||
      !("embedding" in item) ||
      !Array.isArray((item as Record<string, unknown>)["embedding"])
    ) {
      throw new Error(`Anthropic embeddings API: item ${index} missing embedding array`);
    }

    const raw = (item as { embedding: unknown[] })["embedding"];
    const embedding = raw.map((value, vectorIndex) => {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new Error(
          `Anthropic embeddings API: item ${index} embedding[${vectorIndex}] is not a finite number`
        );
      }
      return value;
    });

    return { embedding: embedding as readonly number[] };
  });

  return { embeddings };
}

async function batchEmbed(
  client: AnthropicEmbeddingClientLike,
  model: string,
  texts: string[]
): Promise<readonly (readonly number[])[]> {
  const results: (readonly number[])[] = [];

  for (let start = 0; start < texts.length; start += MAX_BATCH_SIZE) {
    const batch = texts.slice(start, start + MAX_BATCH_SIZE);
    const response = await client.createEmbeddings({ model, input: batch });

    if (response.embeddings.length !== batch.length) {
      throw new Error(
        `Anthropic embeddings API returned ${response.embeddings.length} embeddings for ${batch.length} inputs`
      );
    }

    for (const { embedding } of response.embeddings) {
      results.push(embedding);
    }
  }

  return results;
}

export function createAnthropicEmbeddingProvider(
  options: AnthropicEmbeddingProviderOptions = {}
): EmbeddingProvider {
  const apiKey = options.apiKey ?? process.env["ANTHROPIC_API_KEY"] ?? "";
  const model =
    options.model ??
    process.env["ARCHON_EMBEDDING_MODEL"] ??
    DEFAULT_EMBEDDING_MODEL;

  const client: AnthropicEmbeddingClientLike =
    options.client ?? new HttpAnthropicEmbeddingClient(apiKey);

  return {
    async embed(input) {
      const embeddings = await batchEmbed(client, input.model || model, [input.text]);
      const embedding = embeddings[0];
      if (!embedding) {
        throw new Error("Anthropic embedding provider returned no vector for input");
      }
      return embedding;
    },

    async embedQuery(input) {
      const embeddings = await batchEmbed(client, input.model || model, [input.text]);
      const embedding = embeddings[0];
      if (!embedding) {
        throw new Error("Anthropic embedding provider returned no vector for query");
      }
      return embedding;
    }
  };
}

export function isAnthropicEmbeddingConfigured(env?: NodeJS.ProcessEnv): boolean {
  const source = env ?? process.env;
  return Boolean(source["ANTHROPIC_API_KEY"]?.trim());
}
