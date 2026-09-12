import { createHash } from 'node:crypto';
import { env } from 'cloudflare:workers';
import { reset } from 'cloudflare:test';
import { afterEach, expect, it } from 'vitest';
import { PART_SIZE } from '@spatius/contracts';
import { testable } from '../src/index.js';

afterEach(async () => {
  await reset();
});
it('streams the supported 500 MiB audio maximum without buffering the file', async () => {
  const size = 500 * 1024 * 1024;
  const first = new Uint8Array(PART_SIZE);
  first.set(new TextEncoder().encode('RIFFxxxxWAVE'));
  const zeros = new Uint8Array(PART_SIZE);
  const whole = createHash('sha256');
  for (let offset = 0; offset < size; offset += PART_SIZE)
    whole.update(
      (offset === 0 ? first : zeros).subarray(
        0,
        Math.min(PART_SIZE, size - offset),
      ),
    );
  const coordinator = env.UPLOADS.getByName('maximum-upload');
  const created = await coordinator.create({
    requestId: crypto.randomUUID(),
    kind: 'audio',
    contentType: 'audio/wav',
    size,
    sha256: whole.digest('hex'),
  });
  if (!created.ok) throw new Error(created.body.error.code);
  for (
    let offset = 0, number = 1;
    offset < size;
    offset += PART_SIZE, number++
  ) {
    const bytes = (offset === 0 ? first : zeros).subarray(
      0,
      Math.min(PART_SIZE, size - offset),
    );
    const digest = createHash('sha256').update(bytes).digest('hex');
    const permit = await coordinator.beginPart(
      created.value.id,
      number,
      digest,
      bytes.length,
    );
    if (!permit.ok) throw new Error(permit.body.error.code);
    const etag = await testable.streamPart(
      new Request('https://media.example.test/part', {
        method: 'PUT',
        body: bytes,
      }),
      env,
      permit.value,
      number,
      digest,
    );
    expect(
      (
        await coordinator.finishPart(
          created.value.id,
          permit.value.operationId!,
          etag,
        )
      ).ok,
    ).toBe(true);
  }
  const completed = await coordinator.complete(created.value.id);
  if (!completed.ok) throw new Error(completed.body.error.code);
  expect(completed.value.status).toBe('completed');
  expect(completed.value.acceptedParts).toHaveLength(63);
  expect((await env.MEDIA_BUCKET.head(`media/${created.value.id}`))?.size).toBe(
    size,
  );
}, 120000);
