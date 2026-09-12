import { isAbsolute } from 'node:path';
import { CliError } from './errors.js';

function origin(value: string, name: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new CliError('INVALID_CONFIG', `${name} must be an absolute origin.`);
  }
  const local = ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/' ||
    (url.protocol !== 'https:' && !(local && url.protocol === 'http:'))
  ) {
    throw new CliError(
      'INVALID_CONFIG',
      `${name} must be an HTTPS origin, or a localhost HTTP origin for development.`,
    );
  }
  return url.origin;
}

export function readConfig(env: NodeJS.ProcessEnv = process.env) {
  const configDir = env.SPATIUS_CONFIG_DIR;
  if (configDir && !isAbsolute(configDir))
    throw new CliError(
      'INVALID_CONFIG',
      'SPATIUS_CONFIG_DIR must be absolute.',
    );
  return {
    studioOrigin: origin(
      env.SPATIUS_STUDIO_URL ?? 'https://api.studio.spatius.ai',
      'SPATIUS_STUDIO_URL',
    ),
    studioWebOrigin: origin(
      env.SPATIUS_STUDIO_WEB_URL ?? 'https://app.spatius.ai',
      'SPATIUS_STUDIO_WEB_URL',
    ),
    consoleOrigin: origin(
      env.SPATIUS_CONSOLE_URL ?? 'https://console.spatius.ai',
      'SPATIUS_CONSOLE_URL',
    ),
    mediaOrigin: origin(
      env.SPATIUS_MEDIA_URL ?? 'https://cli-media.spatius.ai',
      'SPATIUS_MEDIA_URL',
    ),
    ...(configDir ? { configDir } : {}),
  };
}
