import { env } from 'cloudflare:workers';
import { afterEach, expect, it, vi } from 'vitest';
import { authenticate } from '../src/auth.js';

afterEach(() => {
  vi.restoreAllMocks();
});
it('constructs auth requests with native workerd options and URL objects', async () => {
  const fetch = vi
    .spyOn(globalThis, 'fetch')
    .mockImplementation(async (resource, init) => {
      // A fetch-only mock missed redirect:error being rejected by real workerd.
      const outgoing = new Request(resource, init);
      expect(outgoing.url).toBe('https://api.studio.spatius.ai/v1/auth/me');
      expect(outgoing.redirect).toBe('manual');
      expect(outgoing.headers.get('Authorization')).toBe(
        'Bearer native-request-test',
      );
      return Response.json({ user: { id: 'verified-native-user' } });
    });
  expect(
    await authenticate(
      new Request('https://media.example.test/v1/uploads', {
        headers: { Authorization: 'Bearer native-request-test' },
      }),
      env,
    ),
  ).toBe('verified-native-user');
  expect(fetch).toHaveBeenCalledTimes(1);
});
it('rejects every redirect without sending credentials to its destination', async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  for (const status of [301, 302, 303, 307, 308]) {
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async (resource, init) => {
        const outgoing = new Request(resource, init);
        expect(outgoing.redirect).toBe('manual');
        return new Response(null, {
          status,
          headers: { Location: 'https://unexpected.example.test/auth' },
        });
      });
    await expect(
      authenticate(
        new Request('https://media.example.test/v1/uploads', {
          headers: { Authorization: 'Bearer native-request-test' },
        }),
        env,
      ),
    ).rejects.toMatchObject({ status: 503, code: 'auth_unavailable' });
    expect(fetch).toHaveBeenCalledTimes(1);
    fetch.mockRestore();
  }
});
