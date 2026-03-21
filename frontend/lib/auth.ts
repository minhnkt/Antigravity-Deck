// === Auth Key Management ===
// Stores auth key in both localStorage AND a cookie for resilience.
// Mobile browsers can purge localStorage when killing tabs under memory pressure,
// but cookies survive. We read from both and sync if one is missing.

const AUTH_KEY_STORAGE = 'antigravity_auth_key';
const AUTH_KEY_COOKIE = 'ag_auth_key';

function getCookie(name: string): string {
    if (typeof document === 'undefined') return '';
    const match = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
    return match ? decodeURIComponent(match[1]) : '';
}

function setCookie(name: string, value: string): void {
    if (typeof document === 'undefined') return;
    // 30-day expiry, SameSite=Strict for security
    document.cookie = `${name}=${encodeURIComponent(value)};path=/;max-age=${30 * 86400};SameSite=Strict`;
}

function deleteCookie(name: string): void {
    if (typeof document === 'undefined') return;
    document.cookie = `${name}=;path=/;max-age=0`;
}

export function getAuthKey(): string {
    if (typeof window === 'undefined') return '';
    const fromStorage = localStorage.getItem(AUTH_KEY_STORAGE) || '';
    const fromCookie = getCookie(AUTH_KEY_COOKIE);

    // Sync: if one has it and the other doesn't, restore the missing one
    if (fromStorage && !fromCookie) setCookie(AUTH_KEY_COOKIE, fromStorage);
    if (fromCookie && !fromStorage) localStorage.setItem(AUTH_KEY_STORAGE, fromCookie);

    return fromStorage || fromCookie;
}

export function setAuthKey(key: string): void {
    if (typeof window === 'undefined') return;
    localStorage.setItem(AUTH_KEY_STORAGE, key);
    setCookie(AUTH_KEY_COOKIE, key);
}

export function clearAuthKey(): void {
    if (typeof window === 'undefined') return;
    localStorage.removeItem(AUTH_KEY_STORAGE);
    deleteCookie(AUTH_KEY_COOKIE);
}

// Build headers with auth key
export function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
    const key = getAuthKey();
    return {
        'Content-Type': 'application/json',
        ...(key ? { 'X-Auth-Key': key } : {}),
        ...extra,
    };
}

// Build WebSocket URL with auth key as query param
export function authWsUrl(baseUrl: string): string {
    const key = getAuthKey();
    if (!key) return baseUrl;
    const sep = baseUrl.includes('?') ? '&' : '?';
    return `${baseUrl}${sep}auth_key=${encodeURIComponent(key)}`;
}
