/**
 * The one password policy on the platform.
 *
 * It lives in contracts so the API enforces exactly what the sign-in and profile screens promise —
 * before this existed the profile page advertised twelve characters with mixed case and digits while
 * the API accepted any eight, which is the sort of gap that survives a demo and fails an audit.
 *
 * Length carries most of the strength (NIST SP 800-63B), so twelve is the floor and there is no
 * upper composition ceremony beyond three character classes; the rest of the work is done by
 * refusing the passwords people actually pick — their own name, their own e-mail, the service name,
 * a keyboard run, or a repeated character.
 */
export const PASSWORD_MIN = 12;
export const PASSWORD_MAX = 200;

/** Shown under the field, and returned in the API error, so the two can never drift apart. */
export const PASSWORD_RULE_TEXT =
  `At least ${PASSWORD_MIN} characters, including an upper-case letter, a lower-case letter and a digit. `
  + 'It must not contain your name or e-mail address.';
export const PASSWORD_RULE_TEXT_AR =
  `${PASSWORD_MIN} أحرف على الأقل، تتضمن حرفًا كبيرًا وحرفًا صغيرًا ورقمًا. `
  + 'ويجب ألا تحتوي على اسمك أو بريدك الإلكتروني.';

/** Passwords that pass every composition rule and are still the first thing anyone tries. */
const REFUSED = [
  'password', 'passw0rd', 'welcome', 'qwerty', 'asdfgh', 'zxcvbn', 'letmein', 'iloveyou',
  'admin', 'administrator', 'maritime', 'moei', 'shipping', 'vessel', 'seafarer', 'changeme',
];
const KEYBOARD_RUNS = ['qwertyuiop', 'asdfghjkl', 'zxcvbnm', '1234567890', 'abcdefghij'];

export interface PasswordSubject {
  /** The account's e-mail; its local part is refused as a substring. */
  email?: string | null;
  /** The account holder's name; each word of three characters or more is refused. */
  name?: string | null;
}

/**
 * Every reason this password is unacceptable, in the order a person would want to read them.
 * An empty array means it passes. Callers should report all of them at once rather than one per
 * round trip.
 */
export function passwordProblems(password: unknown, subject: PasswordSubject = {}): string[] {
  const problems: string[] = [];
  if (typeof password !== 'string' || password.length === 0) return ['A password is required'];
  if (password.length < PASSWORD_MIN) problems.push(`Password must be at least ${PASSWORD_MIN} characters`);
  if (password.length > PASSWORD_MAX) problems.push(`Password must be at most ${PASSWORD_MAX} characters`);
  if (!/[a-z]/.test(password)) problems.push('Password must contain a lower-case letter');
  if (!/[A-Z]/.test(password)) problems.push('Password must contain an upper-case letter');
  if (!/[0-9]/.test(password)) problems.push('Password must contain a digit');

  const lower = password.toLowerCase();
  if (/^(.)\1+$/.test(password)) problems.push('Password must not be a single repeated character');
  if (REFUSED.some((w) => lower.includes(w))) problems.push('Password contains a word that is too common to allow');
  if (KEYBOARD_RUNS.some((run) => runOf(run, lower))) problems.push('Password contains a keyboard sequence');

  const local = String(subject.email ?? '').split('@')[0].toLowerCase();
  if (local.length >= 3 && lower.includes(local)) problems.push('Password must not contain your e-mail address');
  for (const word of String(subject.name ?? '').toLowerCase().split(/[^a-z0-9]+/)) {
    if (word.length >= 3 && lower.includes(word)) { problems.push('Password must not contain your name'); break; }
  }
  return problems;
}

/** True when the password is acceptable — the form's own gate, using the same rules as the API. */
export const passwordAcceptable = (password: unknown, subject: PasswordSubject = {}): boolean =>
  passwordProblems(password, subject).length === 0;

/** Any run of five or more consecutive characters from `run`, forwards or backwards. */
function runOf(run: string, lower: string): boolean {
  const back = [...run].reverse().join('');
  for (let i = 0; i + 5 <= run.length; i++) {
    if (lower.includes(run.slice(i, i + 5)) || lower.includes(back.slice(i, i + 5))) return true;
  }
  return false;
}
