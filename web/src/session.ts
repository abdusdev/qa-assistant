/**
 * Who is using the page. The access token and the person's name are kept for this browser tab
 * only (sessionStorage): closing the tab signs out, and nothing is written to disk.
 */

const TOKEN_KEY = 'qa-assistant.token';
const NAME_KEY = 'qa-assistant.name';

/** Fired when the server answers 401, so the page can show the sign-in form. */
export const AUTH_REQUIRED_EVENT = 'qa-assistant:auth-required';

function read(key: string): string {
  try {
    return window.sessionStorage.getItem(key) ?? '';
  } catch {
    return '';
  }
}

function write(key: string, value: string): void {
  try {
    if (value === '') window.sessionStorage.removeItem(key);
    else window.sessionStorage.setItem(key, value);
  } catch {
    // Storage can be blocked. The page then asks again on the next load, which is acceptable.
  }
}

export const getToken = (): string => read(TOKEN_KEY);
export const getName = (): string => read(NAME_KEY);

export function signIn(token: string, name: string): void {
  write(TOKEN_KEY, token.trim());
  write(NAME_KEY, name.trim());
}

export function signOut(): void {
  write(TOKEN_KEY, '');
  write(NAME_KEY, '');
}

/** The headers every call carries: the token, and the name that is recorded on changes. */
export function authHeaders(): Record<string, string> {
  const token = getToken();
  const name = getName();
  return {
    ...(token !== '' && { authorization: `Bearer ${token}` }),
    ...(name !== '' && { 'x-user': name }),
  };
}

export function announceAuthRequired(): void {
  window.dispatchEvent(new Event(AUTH_REQUIRED_EVENT));
}
