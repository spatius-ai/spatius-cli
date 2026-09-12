import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  MEDIA,
  matchesMediaSignature,
  validMedia,
  type MediaKind,
} from '@spatius/contracts';
import { CliError } from '../core/errors.js';

export interface LocalMedia {
  path: string;
  size: number;
  sha256: string;
  contentType: string;
}
export function sourceUrl(input: string): string | undefined {
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(input)) return undefined;
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new CliError('INVALID_ARGUMENT', 'The source URL is invalid.', {
      exitCode: 2,
    });
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    input.length > 4096 ||
    /\s/.test(input)
  ) {
    throw new CliError(
      'INVALID_ARGUMENT',
      'Sources require HTTP(S) URLs without embedded credentials, at most 4096 characters.',
      { exitCode: 2 },
    );
  }
  return input;
}
export async function inspectMedia(
  file: string,
  kind: MediaKind,
  signal?: AbortSignal,
): Promise<LocalMedia> {
  const path = resolve(file);
  const handle = await open(path, 'r').catch(() => {
    throw new CliError('FILE_UNREADABLE', 'The input file cannot be read.', {
      exitCode: 2,
    });
  });
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size <= 0 || stat.size > MEDIA[kind].maxBytes) {
      throw new CliError(
        'INVALID_MEDIA',
        `Input must be a nonempty regular file of at most ${MEDIA[kind].maxBytes} bytes.`,
        { exitCode: 2 },
      );
    }
    const header = Buffer.alloc(32);
    const first = await handle.read(header, 0, header.length, 0);
    // ADTS AAC and MP3 share a frame prefix: test the more specific signature first.
    const types = [...MEDIA[kind].types].sort(
      (a, b) => Number(b === 'audio/aac') - Number(a === 'audio/aac'),
    );
    const contentType = types.find((type) =>
      matchesMediaSignature(type, header.subarray(0, first.bytesRead)),
    );
    if (!contentType || !validMedia(kind, contentType, stat.size))
      throw new CliError(
        'UNSUPPORTED_MEDIA',
        'The input bytes do not match a supported media type.',
        { exitCode: 2 },
      );
    const hash = createHash('sha256');
    const buffer = Buffer.alloc(1024 * 1024);
    let offset = 0;
    while (offset < stat.size) {
      signal?.throwIfAborted();
      const { bytesRead } = await handle.read(
        buffer,
        0,
        Math.min(buffer.length, stat.size - offset),
        offset,
      );
      if (!bytesRead)
        throw new CliError(
          'INPUT_CHANGED',
          'The input file changed while being read.',
        );
      hash.update(buffer.subarray(0, bytesRead));
      offset += bytesRead;
    }
    const after = await handle.stat();
    if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs)
      throw new CliError(
        'INPUT_CHANGED',
        'The input file changed while being read.',
      );
    return { path, size: stat.size, contentType, sha256: hash.digest('hex') };
  } finally {
    await handle.close();
  }
}
