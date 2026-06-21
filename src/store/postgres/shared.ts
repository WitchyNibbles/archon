// Shared primitives reused across all postgres sub-modules.

export interface SqlQueryResult<Row> {
  rows: Row[];
  rowCount: number | null;
}

export interface SqlClient {
  query<Row = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[]
  ): Promise<SqlQueryResult<Row>>;
}

export interface JsonRow<T> {
  payload: T;
}

export interface ArtifactHydrationRow {
  id: string;
  runId: string;
  kind: string;
  title: string;
  content: string;
  sourcePath: string | null;
  sourceAnchor: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

export function now(): string {
  return new Date().toISOString();
}

export async function withTransaction<T>(client: SqlClient, work: () => Promise<T>): Promise<T> {
  await client.query("begin");
  try {
    const value = await work();
    await client.query("commit");
    return value;
  } catch (error) {
    await client.query("rollback");
    throw error;
  }
}
