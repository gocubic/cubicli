import chalk from 'chalk';

// ANSI escape codes
export const ESC = '\x1b';
export const CSI = `${ESC}[`;

// Screen control
export const clearScreen = () => process.stdout.write(`${CSI}2J`);
export const clearLine = () => process.stdout.write(`${CSI}2K`);
export const moveCursor = (row: number, col: number) => process.stdout.write(`${CSI}${row};${col}H`);
export const moveCursorHome = () => process.stdout.write(`${CSI}H`);
export const hideCursor = () => process.stdout.write(`${CSI}?25l`);
export const showCursor = () => process.stdout.write(`${CSI}?25h`);
export const saveScreen = () => process.stdout.write(`${CSI}?1049h`);
export const restoreScreen = () => process.stdout.write(`${CSI}?1049l`);

// Mouse tracking (SGR mode for better compatibility)
export const enableMouseTracking = () => process.stdout.write(`${CSI}?1000h${CSI}?1006h`);
export const disableMouseTracking = () => process.stdout.write(`${CSI}?1006l${CSI}?1000l`);

// Get terminal dimensions
export function getTerminalSize(): { rows: number; cols: number } {
  return {
    rows: process.stdout.rows || 24,
    cols: process.stdout.columns || 80,
  };
}

// Box drawing characters
export const BOX = {
  topLeft: '┌',
  topRight: '┐',
  bottomLeft: '└',
  bottomRight: '┘',
  horizontal: '─',
  vertical: '│',
  leftT: '├',
  rightT: '┤',
  topT: '┬',
  bottomT: '┴',
  cross: '┼',
};

// Draw a horizontal line
export function drawHorizontalLine(width: number, left = BOX.leftT, right = BOX.rightT): string {
  return `${left}${BOX.horizontal.repeat(width - 2)}${right}`;
}

// Draw a box border top
export function drawBoxTop(width: number): string {
  return `${BOX.topLeft}${BOX.horizontal.repeat(width - 2)}${BOX.topRight}`;
}

// Draw a box border bottom
export function drawBoxBottom(width: number): string {
  return `${BOX.bottomLeft}${BOX.horizontal.repeat(width - 2)}${BOX.bottomRight}`;
}

// Pad string to width (accounting for ANSI codes)
export function padString(str: string, width: number, align: 'left' | 'right' | 'center' = 'left'): string {
  // Strip ANSI codes to get visible length
  const visibleLength = stripAnsi(str).length;
  const padding = Math.max(0, width - visibleLength);

  switch (align) {
    case 'right':
      return ' '.repeat(padding) + str;
    case 'center':
      const leftPad = Math.floor(padding / 2);
      const rightPad = padding - leftPad;
      return ' '.repeat(leftPad) + str + ' '.repeat(rightPad);
    default:
      return str + ' '.repeat(padding);
  }
}

// Strip ANSI codes from string
export function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1b\[[0-9;]*m/g, '');
}

// Truncate string to width (preserving ANSI codes)
export function truncateString(str: string, maxWidth: number): string {
  const visible = stripAnsi(str);
  if (visible.length <= maxWidth) return str;

  // Simple truncation - may break ANSI codes but chalk handles reset
  let visibleCount = 0;
  let result = '';
  let inEscape = false;

  for (const char of str) {
    if (char === '\x1b') {
      inEscape = true;
      result += char;
    } else if (inEscape) {
      result += char;
      if (char === 'm') inEscape = false;
    } else {
      if (visibleCount >= maxWidth - 1) {
        result += '…';
        break;
      }
      result += char;
      visibleCount++;
    }
  }

  return result + chalk.reset('');
}

// Draw a row with borders
export function drawRow(content: string, width: number): string {
  const paddedContent = padString(content, width - 4);
  return `${BOX.vertical} ${truncateString(paddedContent, width - 4)} ${BOX.vertical}`;
}

// Colors
export const colors = {
  title: chalk.bold.cyan,
  subtitle: chalk.dim,
  selected: chalk.bold.white.bgBlue,
  running: chalk.green,
  stopped: chalk.red,
  starting: chalk.yellow,
  error: chalk.red.bold,
  success: chalk.green.bold,
  warning: chalk.yellow,
  info: chalk.blue,
  dim: chalk.dim,
  highlight: chalk.yellow.bold,
  key: chalk.cyan,
  branch: chalk.magenta,
};

// Status indicators
export const STATUS = {
  running: chalk.green('●'),
  stopped: chalk.red('○'),
  starting: chalk.yellow('◐'),
  error: chalk.red('✖'),
};

// Clear to end of line escape code
export const CLEAR_EOL = `${CSI}K`;

// Write to stdout without newline
export function write(str: string): void {
  process.stdout.write(str);
}

// Write line to stdout
export function writeLine(str: string): void {
  process.stdout.write(str + '\n');
}

// Clear and redraw screen
export function redraw(lines: string[]): void {
  moveCursorHome();
  for (const line of lines) {
    clearLine();
    writeLine(line);
  }
}

/**
 * Render all lines in a single write to prevent flickering.
 * Each line is followed by clear-to-end-of-line to remove any leftover content.
 */
export function renderFrame(lines: string[]): void {
  // Build entire frame as single string
  // Move cursor home, then each line clears to EOL
  const frame = `${CSI}H` + lines.map(line => line + CLEAR_EOL).join('\n') + '\n';
  process.stdout.write(frame);
}
