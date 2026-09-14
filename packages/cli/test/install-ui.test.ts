import { afterEach, describe, expect, it, vi } from 'vitest';
import { createInstallerUI } from '../src/install/ui.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('installer terminal cleanup', () => {
  it.each([null, false, true])(
    'restores stdin when its original flowing state was %s',
    (flowing) => {
      vi.spyOn(process.stdin, 'readableFlowing', 'get').mockReturnValue(
        flowing,
      );
      const pause = vi
        .spyOn(process.stdin, 'pause')
        .mockReturnValue(process.stdin);
      const resume = vi
        .spyOn(process.stdin, 'resume')
        .mockReturnValue(process.stdin);
      const write = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
      const ui = createInstallerUI(new AbortController().signal);
      ui.close();
      ui.close();
      expect(pause).toHaveBeenCalledTimes(flowing === true ? 0 : 1);
      expect(resume).toHaveBeenCalledTimes(flowing === true ? 1 : 0);
      expect(write).toHaveBeenCalledTimes(1);
      expect(write).toHaveBeenCalledWith('\u001b[?25h');
    },
  );
  it('releases terminal input before a child takes over and restores the cursor on failure', async () => {
    vi.spyOn(process.stdin, 'readableFlowing', 'get').mockReturnValue(null);
    const pause = vi
      .spyOn(process.stdin, 'pause')
      .mockReturnValue(process.stdin);
    const resume = vi
      .spyOn(process.stdin, 'resume')
      .mockReturnValue(process.stdin);
    const write = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const ui = createInstallerUI(new AbortController().signal);
    const work = vi.fn(async () => {
      expect(pause).toHaveBeenCalled();
      throw new Error('child failed');
    });
    await expect(ui.handoff(work)).rejects.toThrow('child failed');
    ui.close();
    expect(resume).not.toHaveBeenCalled();
    expect(write).toHaveBeenCalledWith('\u001b[?25h');
  });
});

it('normalizes empty NO_COLOR for Clack and restores the original environment', () => {
  vi.stubEnv('NO_COLOR', '');
  vi.stubEnv('FORCE_COLOR', '1');
  vi.spyOn(process.stdin, 'pause').mockReturnValue(process.stdin);
  vi.spyOn(process.stdin, 'resume').mockReturnValue(process.stdin);
  vi.spyOn(process.stdout, 'write').mockReturnValue(true);
  const ui = createInstallerUI(new AbortController().signal);
  expect(process.env.NO_COLOR).toBe('1');
  expect(process.env.FORCE_COLOR).toBe('0');
  ui.close();
  expect(process.env.NO_COLOR).toBe('');
  expect(process.env.FORCE_COLOR).toBe('1');
});
