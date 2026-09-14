// Adapted from create-spatius-app (MIT, spatialwalk 2026).
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import type { WriteStream } from 'node:tty';
import { stripVTControlCharacters } from 'node:util';

import type { TerminalTheme } from './theme.js';

const WIDTH = 36;
const HEIGHT = 11;
const FRAME_MS = 1000 / 12;
const RAMP = ' .,:;+=*#%@';

/** The same breathing surface used in the approved Presence concept. */
export function renderPresenceFrame(
  time: number,
  theme: TerminalTheme,
): string[] {
  const radius = 1.12 + 0.055 * Math.sin(time * 1.3);
  return Array.from({ length: HEIGHT }, (_, row) => {
    let line = '';
    for (let column = 0; column < WIDTH; column++) {
      const x = (column - 17.5) / 7.7;
      const y = (5 - row) / 3.85;
      const distance = x * x + y * y;
      if (distance > radius * radius) {
        line += ' ';
        continue;
      }
      const z = Math.sqrt(radius * radius - distance);
      const longitude = Math.atan2(x, z) + time * 0.35;
      const weave =
        0.5 +
        0.5 *
          Math.sin(
            longitude * 8 + y * 5 + Math.sin(y * 5 - time) * 1.1 - time * 0.8,
          );
      const light = Math.max(0, (-x * 0.45 + y * 0.45 + z * 0.7) / radius);
      const value =
        0.12 +
        0.65 * light * (0.3 + 0.7 * weave) +
        0.12 * Math.pow(z / radius, 3);
      const character = RAMP[Math.floor(value * (RAMP.length - 1))]!;
      line +=
        value > 0.32 ? theme.highlight(character) : theme.accent(character);
    }
    return line;
  });
}

interface PresenceOutput extends Pick<
  WriteStream,
  'write' | 'isTTY' | 'columns' | 'rows'
> {
  on(event: 'resize', listener: () => void): void;
  off(event: 'resize', listener: () => void): void;
}

interface PresenceOptions {
  interactive: boolean;
  theme: TerminalTheme;
  output?: PresenceOutput;
  environment?: NodeJS.ProcessEnv;
}

/** Pauses for prompts, then redraws the welcome while preserving their output. */
export class Presence {
  readonly #output: PresenceOutput;
  readonly #theme: TerminalTheme;
  readonly #environment: NodeJS.ProcessEnv;
  readonly #interactive: boolean;
  #timer?: ReturnType<typeof setInterval>;
  #time = 0;
  #label = '';
  #rendered = false;
  #resized = false;
  #width = 0;
  #anchored = false;
  #row = HEIGHT + 1;
  #column = 0;
  #pending = '';
  #write?: PresenceOutput['write'];

  // Track prompt cursor movement so the welcome can be addressed even after
  // Clack redraws its choices. Unknown controls invalidate the anchor rather
  // than risking an overwrite of prompt text.
  #track(chunk: string): void {
    this.#pending += chunk;
    while (this.#pending.length > 0 && !this.#resized) {
      if (this.#pending.startsWith('\u001b')) {
        if (this.#pending.length < 2) return;
        if (!this.#pending.startsWith('\u001b[')) {
          this.#onResize();
          return;
        }
        const match = /^\[([0-9;?]*)([A-Za-z~])/.exec(this.#pending.slice(1));
        if (!match) {
          if (/^\[[0-9;?]*$/.test(this.#pending.slice(1))) return;
          this.#onResize();
          return;
        }
        this.#pending = this.#pending.slice(match[0].length + 1);
        const count = Number(match[1]) || 1;
        switch (match[2]) {
          case 'A':
            this.#row -= count;
            break;
          case 'B':
            this.#row += count;
            break;
          case 'C':
            this.#column += count;
            break;
          case 'D':
            this.#column = Math.max(0, this.#column - count);
            break;
          case 'G':
            this.#column = count - 1;
            break;
          case 'm':
          case 'K':
            break;
          case 'J':
            if (match[1] !== '' && match[1] !== '0') this.#onResize();
            break;
          case 'h':
          case 'l':
            if (match[1] !== '?25') this.#onResize();
            break;
          default:
            this.#onResize();
        }
      } else {
        const character = String.fromCodePoint(this.#pending.codePointAt(0)!);
        this.#pending = this.#pending.slice(character.length);
        if (character === '\n') {
          this.#row++;
          this.#column = 0;
        } else if (character === '\r') {
          this.#column = 0;
        } else if (character === '\b') {
          this.#column = Math.max(0, this.#column - 1);
        } else if (character >= ' ') {
          // ASCII and Clack's prompt symbols occupy one cell. For other
          // text, fall back instead of guessing emoji/combining/CJK widths.
          if (
            !/^[\x20-\x7e\u2022\u2190-\u2193\u2500-\u25ff]$/.test(character)
          ) {
            this.#onResize();
            return;
          }
          if (this.#column >= this.#width) {
            this.#row++;
            this.#column = 0;
          }
          this.#column++;
        } else {
          this.#onResize();
        }
      }
      if (this.#row >= this.#output.rows || this.#row < HEIGHT + 1) {
        this.#onResize();
      }
    }
  }

  #anchor(): void {
    this.#anchored = true;
    this.#write = this.#output.write;
    const write = this.#write;
    this.#output.write = ((...args: Parameters<PresenceOutput['write']>) => {
      this.#track(typeof args[0] === 'string' ? args[0] : args[0].toString());
      return write.apply(this.#output, args);
    }) as PresenceOutput['write'];
    this.#output.on('resize', this.#onResize);
  }

  #release(): void {
    if (this.#write) this.#output.write = this.#write;
    this.#write = undefined;
    this.#output.off('resize', this.#onResize);
  }

  constructor({
    interactive,
    theme,
    output = process.stdout,
    environment = process.env,
  }: PresenceOptions) {
    this.#interactive = interactive;
    this.#theme = theme;
    this.#output = output;
    this.#environment = environment;
  }

  get visible(): boolean {
    return (
      this.#interactive &&
      this.#output.isTTY === true &&
      !this.#environment.CI &&
      this.#environment.TERM !== 'dumb' &&
      this.#output.columns >= WIDTH + 1 &&
      this.#output.rows >= HEIGHT + 8
    );
  }

  get animated(): boolean {
    return this.visible && !('NO_COLOR' in this.#environment);
  }

  readonly #onResize = (): void => {
    // A resize can reflow earlier lines. Do not move the cursor relative to
    // the old geometry, which could erase output outside our block.
    this.#resized = true;
    this.#clearTimer();
  };

  #draw(): void {
    if (this.#resized) return;
    const lines = renderPresenceFrame(this.#time, this.#theme);
    if (this.#width >= 65) {
      lines[4] += `  ${this.#theme.highlight('Spatius')}`;
      lines[5] += '  a presence, taking shape.';
    }
    // Reserve one column to avoid automatic wrapping, including the status.
    lines.push(
      stripVTControlCharacters(this.#label)
        .replace(/[\r\n]/g, ' ')
        .slice(0, this.#width - 1),
    );
    if (this.#anchored) {
      if (this.#write) {
        this.#write.call(
          this.#output,
          `\u001b7\u001b[${this.#row}A\r` +
            lines.map((line) => `\u001b[2K${line}`).join('\n') +
            '\u001b8',
        );
      }
      return;
    }
    const rewind = this.#rendered ? `\u001b[${HEIGHT + 1}A\r` : '';
    this.#output.write(
      rewind +
        lines
          .map((line) => `${this.#rendered ? '\u001b[2K' : ''}${line}\n`)
          .join(''),
    );
    this.#rendered = true;
  }

  #clearTimer(): void {
    if (this.#timer !== undefined) clearInterval(this.#timer);
    this.#timer = undefined;
    this.#output.off('resize', this.#onResize);
  }

  async welcome(): Promise<void> {
    if (!this.visible) return;
    this.start('');
    try {
      if (this.animated) await delay(1000);
    } finally {
      this.#clearTimer();
      if (this.animated && !this.#resized) this.#anchor();
      else this.#rendered = false;
    }
  }

  start(label: string): void {
    this.#clearTimer();
    if (!this.visible) return;
    this.#label = label;
    if (this.#anchored) {
      if (this.#resized) {
        this.#output.write(`${label}\n`);
        return;
      }
    } else {
      this.#rendered = false;
      this.#resized = false;
    }
    this.#width = this.#output.columns;
    this.#draw();
    if (this.animated) {
      this.#output.on('resize', this.#onResize);
      this.#timer = setInterval(() => {
        this.#time += FRAME_MS / 1000;
        this.#draw();
      }, FRAME_MS);
      // Animation must not keep the CLI alive after its work finishes.
      this.#timer.unref();
    }
  }

  message(label: string): void {
    this.#label = label;
    if (this.#anchored && this.#resized) this.#output.write(`${label}\n`);
  }

  stop(label?: string): void {
    this.#clearTimer();
    if (label !== undefined && this.#rendered) {
      this.#label = label;
      if (this.#resized || !this.animated) this.#output.write(`${label}\n`);
      else this.#draw();
    }
    this.#release();
    this.#rendered = false;
    this.#anchored = false;
  }
}
