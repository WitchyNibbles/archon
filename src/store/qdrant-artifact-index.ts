function validateRuntimeQdrantUrl(baseUrl: string, _runtimeProfile: string): string {
  const url = new URL(baseUrl);
  if (!url.pathname.endsWith("/")) {
    url.pathname = `${url.pathname}/`;
  }
  return url.toString();
}

export interface ArtifactVectorMatch {
  id: string;
  score: number;
}

export interface ArtifactVectorPoint {
  id: string;
  vector: readonly number[];
  projectId: string;
  sourcePath?: string | undefined;
  sourceAnchor?: string | undefined;
  retrievalRoles: readonly string[];
  tags: readonly string[];
}

export interface ArtifactVectorIndex {
  upsertArtifactPoint(input: {
    baseUrl: string;
    runtimeProfile: string;
    collection: string;
    point: ArtifactVectorPoint;
  }): Promise<void>;
  deleteProjectArtifacts(input: {
    baseUrl: string;
    runtimeProfile: string;
    collection: string;
    projectId: string;
  }): Promise<void>;
  queryArtifactMatches(input: {
    baseUrl: string;
    runtimeProfile: string;
    collection: string;
    projectId: string;
    vector: readonly number[];
    limit: number;
  }): Promise<readonly ArtifactVectorMatch[]>;
}

interface QdrantCollectionResponse {
  result?: {
    config?: {
      params?: {
        vectors?: { size?: number } | Record<string, { size?: number }>;
      };
    };
  };
}

interface QdrantQueryResponse {
  result?:
    | Array<{
        id: string | number;
        score?: number | null;
      }>
    | {
        points?: Array<{
          id: string | number;
          score?: number | null;
        }>;
      };
}

type FetchLike = typeof fetch;

export class QdrantArtifactIndex implements ArtifactVectorIndex {
  private readonly fetchImpl: FetchLike;
  private readonly ensuredCollections = new Map<string, number>();

  constructor(fetchImpl: FetchLike = fetch) {
    this.fetchImpl = fetchImpl;
  }

  async upsertArtifactPoint(input: {
    baseUrl: string;
    runtimeProfile: string;
    collection: string;
    point: ArtifactVectorPoint;
  }): Promise<void> {
    const baseUrl = validateRuntimeQdrantUrl(input.baseUrl, input.runtimeProfile);
    await this.ensureCollection(baseUrl, input.collection, input.point.vector.length);
    await this.requestJson(this.collectionUrl(baseUrl, input.collection, "points", true), {
      method: "PUT",
      body: JSON.stringify({
        points: [
          {
            id: input.point.id,
            vector: [...input.point.vector],
            payload: {
              projectId: input.point.projectId,
              sourcePath: input.point.sourcePath ?? null,
              sourceAnchor: input.point.sourceAnchor ?? null,
              retrievalRoles: [...input.point.retrievalRoles],
              tags: [...input.point.tags]
            }
          }
        ]
      })
    });
  }

  async deleteProjectArtifacts(input: {
    baseUrl: string;
    runtimeProfile: string;
    collection: string;
    projectId: string;
  }): Promise<void> {
    const baseUrl = validateRuntimeQdrantUrl(input.baseUrl, input.runtimeProfile);
    await this.requestJson(
      this.collectionUrl(baseUrl, input.collection, "points/delete", true),
      {
        method: "POST",
        body: JSON.stringify({
          filter: {
            must: [
              {
                key: "projectId",
                match: {
                  value: input.projectId
                }
              }
            ]
          }
        })
      },
      { allowNotFound: true }
    );
  }

  async queryArtifactMatches(input: {
    baseUrl: string;
    runtimeProfile: string;
    collection: string;
    projectId: string;
    vector: readonly number[];
    limit: number;
  }): Promise<readonly ArtifactVectorMatch[]> {
    const baseUrl = validateRuntimeQdrantUrl(input.baseUrl, input.runtimeProfile);
    const body = await this.requestJson<QdrantQueryResponse>(
      this.collectionUrl(baseUrl, input.collection, "points/query", false),
      {
        method: "POST",
        body: JSON.stringify({
          query: [...input.vector],
          limit: input.limit,
          with_payload: false,
          with_vector: false,
          filter: {
            must: [
              {
                key: "projectId",
                match: {
                  value: input.projectId
                }
              }
            ]
          }
        })
      },
      { allowNotFound: true }
    );

    const matches = Array.isArray(body?.result)
      ? body.result
      : Array.isArray(body?.result?.points)
        ? body.result.points
        : [];

    return matches
      .map((candidate) => ({
        id: String(candidate.id),
        score: Number(candidate.score ?? 0)
      }))
      .filter((candidate) => candidate.id.length > 0 && Number.isFinite(candidate.score));
  }

  private async ensureCollection(baseUrl: string, collection: string, vectorSize: number): Promise<void> {
    const cacheKey = `${baseUrl}::${collection}`;
    const cachedSize = this.ensuredCollections.get(cacheKey);
    if (cachedSize === vectorSize) {
      return;
    }

    const details = await this.requestJson<QdrantCollectionResponse>(
      this.collectionUrl(baseUrl, collection, "", false),
      { method: "GET" },
      { allowNotFound: true }
    );

    const existingSize = extractCollectionVectorSize(details);
    if (existingSize && existingSize !== vectorSize) {
      throw new Error(
        `Qdrant collection ${collection} vector size mismatch: expected ${vectorSize}, received ${existingSize}`
      );
    }

    if (!details) {
      await this.requestJson(this.collectionUrl(baseUrl, collection, "", true), {
        method: "PUT",
        body: JSON.stringify({
          vectors: {
            size: vectorSize,
            distance: "Cosine"
          }
        })
      });
    }

    this.ensuredCollections.set(cacheKey, vectorSize);
  }

  private collectionUrl(baseUrl: string, collection: string, suffix: string, wait: boolean): string {
    const normalized = new URL(baseUrl);
    if (!normalized.pathname.endsWith("/")) {
      normalized.pathname = `${normalized.pathname}/`;
    }

    const pathname = [`collections`, encodeURIComponent(collection), suffix]
      .filter((value) => value.length > 0)
      .join("/");
    const target = new URL(pathname, normalized);
    if (wait) {
      target.searchParams.set("wait", "true");
    }
    return target.toString();
  }

  private async requestJson<T>(
    url: string,
    init: RequestInit,
    options: { allowNotFound?: boolean | undefined } = {}
  ): Promise<T | undefined> {
    const response = await this.fetchImpl(url, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        ...(init.headers ?? {})
      }
    });

    if (response.status === 404 && options.allowNotFound) {
      return undefined;
    }

    if (!response.ok) {
      throw new Error(`Qdrant request failed (${response.status} ${response.statusText}) for ${url}`);
    }

    if (response.status === 204) {
      return undefined;
    }

    const raw = await response.text();
    if (!raw.trim()) {
      return undefined;
    }

    return JSON.parse(raw) as T;
  }
}

function extractCollectionVectorSize(details: QdrantCollectionResponse | undefined): number | undefined {
  const vectors = details?.result?.config?.params?.vectors;
  if (!vectors) {
    return undefined;
  }

  if (typeof (vectors as { size?: number }).size === "number") {
    return (vectors as { size?: number }).size;
  }

  for (const value of Object.values(vectors)) {
    if (value && typeof value === "object" && typeof value.size === "number") {
      return value.size;
    }
  }

  return undefined;
}
