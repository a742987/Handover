import { sanitizeProse } from './store/sanitize.js';

/**
 * The one way this tool puts a line of output on a stream.
 *
 * Terminal control bytes are stripped here rather than at each call site because
 * nearly every line this CLI prints carries something it did not author: a
 * repository key (the basename of a directory someone else created), a commit
 * message, a file path, a login. A directory name may contain `ESC` on Linux and
 * macOS, and the index database that carries those names is a file people hand to
 * each other — so an escape sequence arriving under the tool's own name is a
 * supported path, not a hypothetical.
 *
 * Tab and newline survive: they are the content of prose, and multi-line records
 * are printed through here too.
 */
export function printLine(stream: { write(chunk: string): void }, text = ''): void {
  stream.write(sanitizeProse(text).replace(/\n+$/, '') + '\n');
}
