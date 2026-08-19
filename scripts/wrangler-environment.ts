import { tmpdir } from 'node:os';
import { join } from 'node:path';

type Environment = Record<string, string | undefined>;

export function inheritWranglerEnvironment(environment: Environment = process.env) {
  return { ...environment };
}

export function createLocalWranglerEnvironment(
  environment: Environment = process.env,
  options: {
    temporaryDirectory?: string;
    joinPath?: (...parts: string[]) => string;
    logFileName?: string;
  } = {}
) {
  const temporaryDirectory = options.temporaryDirectory ?? tmpdir();
  const joinPath = options.joinPath ?? join;
  const next = inheritWranglerEnvironment(environment);
  next.XDG_CONFIG_HOME ??= joinPath(temporaryDirectory, 'flaremail-wrangler-config');
  next.WRANGLER_LOG_PATH ??= joinPath(
    temporaryDirectory,
    options.logFileName ?? 'flaremail-wrangler.log'
  );
  return next;
}
