type Environment = Record<string, string | undefined>;

export function inheritCloudflareEnvironment(environment: Environment = process.env) {
  return { ...environment };
}

// Every local resource invocation also supplies --local and an isolated --persist-to.
export function createLocalCloudflareEnvironment(environment: Environment = process.env) {
  return inheritCloudflareEnvironment(environment);
}
