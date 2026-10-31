// Guestbook client. Live mode talks to the Go backend; demo mode keeps
// entries in this browser only (localStorage), and says so in the UI.
import { API_BASE } from './backend';

export interface Entry {
  id: string;
  name: string;
  message: string;
  at: string; // RFC 3339
  local?: boolean;
}

export type PostResult = { ok: true; entry: Entry } | { ok: false; error: string; field?: string };

// Must match the backend limits in internal/api/community.go.
export const MAX_NAME = 24;
export const MAX_MESSAGE = 280;

const LOCAL_KEY = 'city.guestbook.v1';
const NAME_KEY = 'city.guestbook.name';

function readLocal(): Entry[] {
  try {
    const v = JSON.parse(localStorage.getItem(LOCAL_KEY) ?? '[]');
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function writeLocal(es: Entry[]): boolean {
  try {
    localStorage.setItem(LOCAL_KEY, JSON.stringify(es.slice(0, 50)));
    return true;
  } catch {
    return false;
  }
}

export function rememberedName(): string {
  try {
    return localStorage.getItem(NAME_KEY) ?? '';
  } catch {
    return '';
  }
}

function rememberName(n: string) {
  try {
    localStorage.setItem(NAME_KEY, n);
  } catch {
    /* private mode: fine */
  }
}

export class GuestbookClient {
  constructor(private live: () => boolean) {}

  get isLive() {
    return this.live();
  }

  async list(): Promise<Entry[]> {
    if (!this.live()) return readLocal();
    const r = await fetch(`${API_BASE}/api/guestbook?limit=50`, { cache: 'no-store' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return ((await r.json()) as { entries: Entry[] }).entries;
  }

  async post(name: string, message: string): Promise<PostResult> {
    name = name.trim();
    message = message.trim();
    if (!message) return { ok: false, error: 'Write a message first.', field: 'message' };
    if ([...name].length > MAX_NAME) return { ok: false, error: `Name can be at most ${MAX_NAME} characters.`, field: 'name' };
    if ([...message].length > MAX_MESSAGE) return { ok: false, error: `Message can be at most ${MAX_MESSAGE} characters.`, field: 'message' };
    rememberName(name);

    if (!this.live()) {
      const entry: Entry = {
        id: `local-${Date.now()}`, name: name || 'You', message, at: new Date().toISOString(), local: true,
      };
      const ok = writeLocal([entry, ...readLocal()]);
      return ok ? { ok: true, entry } : { ok: false, error: 'This browser blocks local storage, so the demo guestbook can’t save.' };
    }

    try {
      const r = await fetch(`${API_BASE}/api/guestbook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, message }),
      });
      const body = await r.json().catch(() => ({}));
      if (r.ok) return { ok: true, entry: body as Entry };
      return { ok: false, error: sentence(body.error ?? `The server refused the message (HTTP ${r.status}).`), field: body.field };
    } catch {
      return { ok: false, error: 'Couldn’t reach the server. Check your connection and try again.' };
    }
  }
}

function sentence(s: string): string {
  s = s.charAt(0).toUpperCase() + s.slice(1);
  return /[.!?]$/.test(s) ? s : s + '.';
}
