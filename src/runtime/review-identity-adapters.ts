import {
  createReviewPrincipalAdapter,
  type AuthenticatedPrincipal,
  type ReviewPrincipalAdapter
} from "../core/review-context.ts";

export function createStaticReviewIdentityAdapter(
  principal: AuthenticatedPrincipal
): ReviewPrincipalAdapter<unknown> {
  return createReviewPrincipalAdapter(async () => principal);
}

export function createHeaderReviewIdentityAdapter(options: {
  provider: string;
  subjectHeader: string;
  verifiedHeader?: string | undefined;
  verifiedValue?: string | undefined;
  displayNameHeader?: string | undefined;
  emailHeader?: string | undefined;
  groupsHeader?: string | undefined;
  groupsDelimiter?: string | undefined;
}): ReviewPrincipalAdapter<Record<string, unknown>> {
  const groupsDelimiter = options.groupsDelimiter ?? ",";

  return createReviewPrincipalAdapter(async ({ authContext }) => {
    const headers = normalizeHeaders(authContext);
    const subject = readHeader(headers, options.subjectHeader);
    if (!subject) {
      throw new Error(`Missing authenticated subject header: ${options.subjectHeader}`);
    }

    const verified = options.verifiedHeader
      ? readHeader(headers, options.verifiedHeader) === (options.verifiedValue ?? "true")
      : true;

    return {
      provider: options.provider,
      subject,
      verified,
      displayName: readHeader(headers, options.displayNameHeader),
      email: readHeader(headers, options.emailHeader),
      groups: readHeader(headers, options.groupsHeader)
        ?.split(groupsDelimiter)
        .map((value) => value.trim())
        .filter(Boolean)
    };
  });
}

export function composeReviewIdentityAdapters(
  adapters: readonly ReviewPrincipalAdapter<unknown>[]
): ReviewPrincipalAdapter<unknown> {
  return async (input) => {
    const failures: string[] = [];

    for (const adapter of adapters) {
      try {
        const principal = await adapter(input);
        if (principal.verified) {
          return principal;
        }
        failures.push(`${principal.provider}:${principal.subject} not verified`);
      } catch (error) {
        failures.push(error instanceof Error ? error.message : String(error));
      }
    }

    throw new Error(`No review identity adapter accepted the auth context: ${failures.join("; ")}`);
  };
}

function normalizeHeaders(input: Record<string, unknown>): Record<string, string> {
  const headers: Record<string, string> = {};

  for (const [key, value] of Object.entries(input)) {
    headers[key.toLowerCase()] = String(value);
  }

  return headers;
}

function readHeader(headers: Record<string, string>, headerName: string | undefined): string | undefined {
  if (!headerName) {
    return undefined;
  }

  const value = headers[headerName.toLowerCase()];
  return value && value.trim().length > 0 ? value.trim() : undefined;
}
