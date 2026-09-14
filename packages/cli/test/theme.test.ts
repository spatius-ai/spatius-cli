import { describe, expect, it } from 'vitest';

import {
  createTerminalTheme,
  SPATIUS_TERMINAL_COLORS,
  supportsTerminalColor,
} from '../src/install/theme.js';

describe('terminal theme', () => {
  it('uses the Luminous marketing palette for capable terminals', () => {
    expect(SPATIUS_TERMINAL_COLORS).toEqual({
      accent: [99, 99, 167],
      deep: [21, 17, 49],
      highlight: [147, 153, 227],
    });
    expect(createTerminalTheme(true).accent('Spatius')).toBe(
      '\u001B[38;2;99;99;167mSpatius\u001B[39m',
    );
    expect(createTerminalTheme(true).deep('Spatius')).toContain('21;17;49');
  });

  it('respects no-color and non-terminal environments', () => {
    expect(
      supportsTerminalColor({
        environment: { NO_COLOR: '1' },
        isTerminal: true,
      }),
    ).toBe(false);
    expect(supportsTerminalColor({ environment: {}, isTerminal: false })).toBe(
      false,
    );
    expect(createTerminalTheme(false).highlight('Ready')).toBe('Ready');
  });

  it('supports explicit color forcing except for a disabled value', () => {
    expect(
      supportsTerminalColor({
        environment: { FORCE_COLOR: '1' },
        isTerminal: false,
      }),
    ).toBe(true);
    expect(
      supportsTerminalColor({
        environment: { FORCE_COLOR: '0' },
        isTerminal: true,
      }),
    ).toBe(false);
  });
});
