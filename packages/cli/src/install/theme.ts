// Adapted from create-spatius-app (MIT, spatialwalk 2026).
import type { WriteStream } from 'node:tty';

export const SPATIUS_TERMINAL_COLORS = {
  accent: [99, 99, 167],
  deep: [21, 17, 49],
  highlight: [147, 153, 227],
} as const;

interface ColorSupportOptions {
  environment?: NodeJS.ProcessEnv;
  isTerminal?: boolean;
}

function isDisabledValue(value: string | undefined): boolean {
  return (
    value !== undefined && ['', '0', 'false'].includes(value.toLowerCase())
  );
}

export function supportsTerminalColor({
  environment = process.env,
  isTerminal = (process.stdout as WriteStream).isTTY === true,
}: ColorSupportOptions = {}): boolean {
  if ('NO_COLOR' in environment) {
    return false;
  }

  if (environment.FORCE_COLOR !== undefined) {
    return !isDisabledValue(environment.FORCE_COLOR);
  }

  return isTerminal && environment.TERM !== 'dumb';
}

function rgb(
  value: string,
  [red, green, blue]: readonly [number, number, number],
  enabled: boolean,
): string {
  return enabled
    ? `\u001B[38;2;${String(red)};${String(green)};${String(blue)}m${value}\u001B[39m`
    : value;
}

export interface TerminalTheme {
  accent: (value: string) => string;
  deep: (value: string) => string;
  highlight: (value: string) => string;
}

export function createTerminalTheme(
  enabled = supportsTerminalColor(),
): TerminalTheme {
  return {
    accent: (value) => rgb(value, SPATIUS_TERMINAL_COLORS.accent, enabled),
    deep: (value) => rgb(value, SPATIUS_TERMINAL_COLORS.deep, enabled),
    highlight: (value) =>
      rgb(value, SPATIUS_TERMINAL_COLORS.highlight, enabled),
  };
}
