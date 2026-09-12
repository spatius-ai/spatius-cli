import { describe, it, expect, vi } from 'vitest';
import { requestJson, readJson } from '../src/core/http.js';
import { readConfig } from '../src/core/config.js';

describe('HTTP boundaries', () => {
  it('forbids credential-bearing redirects and does not retry POST by default', async () => {
    const send = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new TypeError('fetch failed with token=secret'));
    await expect(
      requestJson('https://console.example/v1/open/avatars', {
        method: 'POST',
        body: { imageUrl: 'https://example/image' },
        headers: { 'x-api-key': 'secret' },
        fetch: send,
      }),
    ).rejects.toMatchObject({ code: 'NETWORK_ERROR' });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]?.[1]?.redirect).toBe('error');
  });
  it('does not expose backend error bodies containing credentials', async () => {
    const send = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json(
        {
          error: {
            code: 'forbidden',
            message: 'bad sk-secret https://example?token=secret',
          },
        },
        { status: 403 },
      ),
    );
    let caught: unknown;
    try {
      await requestJson('https://console.example', { fetch: send });
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({
      code: 'forbidden',
      options: { status: 403 },
    });
    expect(JSON.stringify(caught)).not.toContain('sk-secret');
    expect(JSON.stringify(caught)).not.toContain('token=');
  });
  it('bounds streaming JSON regardless of Content-Length', async () => {
    const response = new Response(
      new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode('x'.repeat(20)));
          c.close();
        },
      }),
    );
    await expect(readJson(response, 10)).rejects.toMatchObject({
      code: 'INVALID_RESPONSE',
    });
  });
  it('returns long rate limits to the caller instead of hidden waits', async () => {
    const send = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json(
          { error: { code: 'rate_limit_exceeded' } },
          { status: 429, headers: { 'retry-after': '3600' } },
        ),
      );
    await expect(
      requestJson('https://console.example', { fetch: send }),
    ).rejects.toMatchObject({ options: { retryAfter: 3600 } });
    expect(send).toHaveBeenCalledTimes(1);
  });
  it('accepts explicit localhost development origins and rejects credentials or path overrides', () => {
    expect(
      readConfig({ SPATIUS_CONSOLE_URL: 'http://127.0.0.1:8083' })
        .consoleOrigin,
    ).toBe('http://127.0.0.1:8083');
    expect(readConfig({})).toMatchObject({
      studioOrigin: 'https://api.studio.spatius.ai',
      studioWebOrigin: 'https://app.spatius.ai',
      consoleOrigin: 'https://console.spatius.ai',
    });
    expect(
      readConfig({ SPATIUS_STUDIO_WEB_URL: 'http://127.0.0.1:3000' })
        .studioWebOrigin,
    ).toBe('http://127.0.0.1:3000');
    for (const value of [
      'https://user:pass@example.com',
      'https://example.com/api',
      'http://remote.example',
      'https://example.com?token=abc',
    ]) {
      expect(() => readConfig({ SPATIUS_STUDIO_URL: value })).toThrow();
      expect(() => readConfig({ SPATIUS_STUDIO_WEB_URL: value })).toThrow();
    }
  });
});
