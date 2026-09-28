/** True when two GitHub logins refer to the same account (logins are case-insensitive). */
export function sameLogin(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}
