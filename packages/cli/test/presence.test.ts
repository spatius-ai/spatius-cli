import { PassThrough } from 'node:stream';
import { stripVTControlCharacters } from 'node:util';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { Presence, renderPresenceFrame } from '../src/install/presence.js';
import { createTerminalTheme } from '../src/install/theme.js';

function terminal(columns = 80, rows = 30) {
  const output = Object.assign(new PassThrough(), {
    columns,
    rows,
    isTTY: true,
  });
  const chunks: string[] = [];
  output.on('data', (chunk: Buffer) => chunks.push(chunk.toString()));
  return { output, chunks };
}

afterEach(() => vi.useRealTimers());

describe('Presence artwork', () => {
  it('animates within a fixed ASCII grid, with or without color', () => {
    const plain = createTerminalTheme(false);
    const colored = createTerminalTheme(true);
    const frames = [0, 0.5, 1, 4, 8].map((time) =>
      renderPresenceFrame(time, plain),
    );
    for (const frame of frames) {
      expect(frame).toHaveLength(11);
      for (const line of frame) {
        expect(line).toHaveLength(36);
        expect(line).toMatch(/^[ .,:;+=*#%@]+$/);
      }
    }
    expect(new Set(frames.map((frame) => frame.join('\n'))).size).toBe(
      frames.length,
    );
    expect(
      renderPresenceFrame(0, colored).map(stripVTControlCharacters),
    ).toEqual(frames[0]);
  });

  it.each([
    { interactive: false, isTTY: true, environment: {} },
    { interactive: true, isTTY: false, environment: { FORCE_COLOR: '1' } },
    { interactive: true, isTTY: true, environment: { CI: 'true' } },
    { interactive: true, isTTY: true, environment: { TERM: 'dumb' } },
  ])(
    'does not decorate noninteractive or unsuitable output: %j',
    async (options) => {
      const { output, chunks } = terminal();
      output.isTTY = options.isTTY;
      const presence = new Presence({
        ...options,
        output,
        theme: createTerminalTheme(false),
      });
      await presence.welcome();
      presence.start('Installing');
      presence.stop('Done');
      expect(chunks).toEqual([]);
      expect(output.listenerCount('resize')).toBe(0);
    },
  );

  it.each([
    [36, 30],
    [80, 18],
  ])('skips artwork in a %i × %i terminal', async (columns, rows) => {
    const { output, chunks } = terminal(columns, rows);
    const presence = new Presence({
      interactive: true,
      output,
      environment: {},
      theme: createTerminalTheme(false),
    });
    await presence.welcome();
    expect(chunks).toEqual([]);
  });

  it('prints a static monochrome welcome without timers or cursor escapes for NO_COLOR', async () => {
    vi.useFakeTimers();
    const { output, chunks } = terminal();
    const presence = new Presence({
      interactive: true,
      output,
      environment: { NO_COLOR: '' },
      theme: createTerminalTheme(false),
    });
    await presence.welcome();
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toContain('Spatius');
    expect(chunks[0]).not.toContain('\u001b');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('settles the welcome before returning control to prompts', async () => {
    vi.useFakeTimers();
    const { output, chunks } = terminal();
    const presence = new Presence({
      interactive: true,
      output,
      environment: {},
      theme: createTerminalTheme(false),
    });
    const welcome = presence.welcome();
    await vi.advanceTimersByTimeAsync(1000);
    await welcome;
    expect(chunks.length).toBeGreaterThan(10);
    const count = chunks.length;
    await vi.advanceTimersByTimeAsync(2000);
    expect(chunks).toHaveLength(count);
    expect(vi.getTimerCount()).toBe(0);
    expect(output.listenerCount('resize')).toBe(1);
    presence.stop();
    expect(output.listenerCount('resize')).toBe(0);
  });

  it('resumes the welcome above completed prompts and restores the output writer', async () => {
    vi.useFakeTimers();
    const { output, chunks } = terminal();
    const write = vi.spyOn(output, 'write');
    const presence = new Presence({
      interactive: true,
      output,
      environment: {},
      theme: createTerminalTheme(false),
    });
    const welcome = presence.welcome();
    await vi.advanceTimersByTimeAsync(1000);
    await welcome;
    output.write(
      'Which package manager?\n● pnpm\n↑/↓ to navigate • Enter: confirm\n',
    );
    output.write('\u001b[3');
    output.write('A\r\u001b[J◇ Which package manager?\npnpm\n');
    presence.start('Installing JavaScript dependencies');
    expect(chunks.at(-1)?.startsWith('\u001b7\u001b[14A\r')).toBe(true);
    expect(chunks.at(-1)).toContain('Spatius');
    expect(chunks.at(-1)?.endsWith('\u001b8')).toBe(true);
    presence.message('Installing Python dependencies');
    await vi.advanceTimersByTimeAsync(100);
    expect(chunks.at(-1)).toContain('Installing Python dependencies');
    presence.stop('Dependencies installed');
    expect(chunks.at(-1)).toContain('Dependencies installed');
    expect(output).toHaveProperty('write', write);
    expect(output.listenerCount('resize')).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['resize', 'scroll', 'wide input', 'clear screen'])(
    'uses status text without duplicate art when the welcome anchor is lost: %s',
    async (reason) => {
      vi.useFakeTimers();
      const { output, chunks } = terminal();
      const write = vi.spyOn(output, 'write');
      const presence = new Presence({
        interactive: true,
        output,
        environment: {},
        theme: createTerminalTheme(false),
      });
      const welcome = presence.welcome();
      await vi.advanceTimersByTimeAsync(1000);
      await welcome;
      if (reason === 'resize') output.emit('resize');
      if (reason === 'scroll') output.write('answer\n'.repeat(30));
      if (reason === 'wide input') output.write('项目');
      if (reason === 'clear screen') output.write('\u001b[2J');
      const count = chunks.length;
      presence.start('Installing JavaScript dependencies');
      presence.message('Installing Python dependencies');
      presence.stop('Dependencies installed');
      expect(chunks.slice(count)).toEqual([
        'Installing JavaScript dependencies\n',
        'Installing Python dependencies\n',
        'Dependencies installed\n',
      ]);
      expect(output).toHaveProperty('write', write);
      expect(output.listenerCount('resize')).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it('updates installation status and stops drawing on completion or failure', () => {
    vi.useFakeTimers();
    const { output, chunks } = terminal(40);
    const presence = new Presence({
      interactive: true,
      output,
      environment: {},
      theme: createTerminalTheme(false),
    });
    presence.start('Installing JavaScript dependencies');
    presence.message('Installing Python dependencies');
    vi.advanceTimersByTime(100);
    expect(chunks.at(-1)).toContain('Installing Python dependencies');
    presence.stop('Dependency installation failed');
    expect(chunks.at(-1)).toContain('Dependency installation failed');
    const count = chunks.length;
    presence.stop();
    vi.advanceTimersByTime(2000);
    expect(chunks).toHaveLength(count);
    expect(output.listenerCount('resize')).toBe(0);
    expect(chunks.join('')).not.toContain('\u001b[?25l');
    for (const chunk of chunks) {
      expect(
        stripVTControlCharacters(chunk)
          .split('\n')
          .every((line) => line.length < 40),
      ).toBe(true);
    }
  });

  it('stops cursor movement after resize, preserving surrounding output', () => {
    vi.useFakeTimers();
    const { output, chunks } = terminal();
    const presence = new Presence({
      interactive: true,
      output,
      environment: {},
      theme: createTerminalTheme(false),
    });
    presence.start('Installing');
    output.columns = 30;
    output.emit('resize');
    vi.advanceTimersByTime(1000);
    expect(chunks).toHaveLength(1);
    presence.stop('Dependencies installed');
    expect(chunks.at(-1)).toBe('Dependencies installed\n');
    expect(vi.getTimerCount()).toBe(0);
    expect(output.listenerCount('resize')).toBe(0);
  });
});
