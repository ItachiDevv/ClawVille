/** Remove ANSI escape sequences and other control characters (keeps newline and tab). */
export function stripControl(text: string): string {
  return text
    // CSI and OSC sequences, then any other ESC sequence.
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, '')
    .replace(/\u001b./g, '')
    .replace(/\r\n?/g, '\n')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '');
}

/** The last `maxLines` lines of a child's output, stripped of control characters. */
export function outputTail(text: string, maxLines = 20): string[] {
  const lines = stripControl(text)
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);
  return lines.slice(-maxLines).map((line) => (line.length > 300 ? `${line.slice(0, 300)}...` : line));
}
