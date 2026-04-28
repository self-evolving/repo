import { execFileSync } from "node:child_process";

export type GraphQLVariableValue =
  | string
  | number
  | boolean
  | null
  | undefined;

const DEFAULT_MAX_BUFFER = 16 * 1024 * 1024;

export interface GraphQLClient {
  graphql<T>(
    query: string,
    variables: Record<string, GraphQLVariableValue>,
  ): T;
}

/**
 * Calls `gh api graphql` and returns the decoded `data` payload.
 */
export function ghGraphqlData<T>(
  query: string,
  variables: Record<string, GraphQLVariableValue>,
  options: { maxBuffer?: number } = {},
): T {
  const args = ["api", "graphql", "-f", `query=${query}`];
  for (const [key, value] of Object.entries(variables)) {
    if (typeof value === "number" || typeof value === "boolean") {
      args.push("-F", `${key}=${value}`);
    } else if (value != null) {
      args.push("-f", `${key}=${value}`);
    }
  }

  const stdout = execFileSync("gh", args, {
    stdio: ["pipe", "pipe", "pipe"],
    maxBuffer: options.maxBuffer ?? DEFAULT_MAX_BUFFER,
  }).toString("utf8");
  const payload = JSON.parse(stdout) as {
    data?: T;
    errors?: Array<{ message?: string }>;
  };

  if (Array.isArray(payload.errors) && payload.errors.length > 0) {
    const messages = payload.errors
      .map((error) => error?.message || JSON.stringify(error))
      .join("; ");
    throw new Error(`gh api graphql returned errors: ${messages}`);
  }

  if (payload.data === undefined) {
    throw new Error("gh api graphql returned no data");
  }

  return payload.data;
}

export function createGhGraphqlClient(
  options: { maxBuffer?: number } = {},
): GraphQLClient {
  return {
    graphql<T>(query: string, variables: Record<string, GraphQLVariableValue>): T {
      return ghGraphqlData<T>(query, variables, options);
    },
  };
}
