// Leaderboard client for the tower-defense game.
//
// Live mode: POST /api/runs when a game starts (the server signs a single-use
// run token with the start time), then POST /api/leaderboard with that token
// when it ends. The server rejects scores that couldn't come from a real run
// (see BoardRules in internal/api/community.go). Demo mode keeps the best
// scores in this browser only, and the UI says so.
import { API_BASE } from './backend';
import { MAX_NAME, rememberedName } from './guestbook';

export const BOARD = 'defense';

export interface ScoreRow {
  name: string;
  score: number;
  wave: number;
  durationMs: number;
  at: string;
  local?: boolean;
}

export type SubmitResult =
  | { ok: true; rank: number; improved: boolean; best: number; local: boolean }
  | { ok: false; error: string; field?: string };

const LOCAL_KEY = 'city.defense.scores.v1';

function readLocal(): ScoreRow[] {
  try {
    const v = JSON.parse(localStorage.getItem(LOCAL_KEY) ?? '[]');
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function writeLocal(rows: ScoreRow[]): boolean {
  try {
    localStorage.setItem(LOCAL_KEY, JSON.stringify(rows));
    return true;
  } catch {
    return false;
  }
}

/** Best score per name, highest first (same rule as the server). */
export function rankLocal(rows: ScoreRow[], limit = 10): ScoreRow[] {
  const best = new Map<string, ScoreRow>();
  for (const r of rows) {
    const k = r.name.toLowerCase();
    const b = best.get(k);
    if (!b || r.score > b.score || (r.score === b.score && r.durationMs < b.durationMs)) best.set(k, r);
  }
  return [...best.values()].sort((a, b) => b.score - a.score || a.durationMs - b.durationMs).slice(0, limit);
}

export class LeaderboardClient {
  private token: string | null = null;

  constructor(private live: () => boolean) {}

  get isLive() {
    return this.live();
  }

  async top(limit = 10): Promise<ScoreRow[]> {
    if (!this.live()) return rankLocal(readLocal(), limit).map((r) => ({ ...r, local: true }));
    const r = await fetch(`${API_BASE}/api/leaderboard?board=${BOARD}&limit=${limit}`, { cache: 'no-store' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return ((await r.json()) as { scores: ScoreRow[] }).scores;
  }

  /** Call when a run starts. In live mode this fetches a signed run token. */
  async start(): Promise<void> {
    this.token = null;
    if (!this.live()) return;
    try {
      const r = await fetch(`${API_BASE}/api/runs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ board: BOARD }),
      });
      if (r.ok) this.token = ((await r.json()) as { token: string }).token;
    } catch {
      /* offline mid-game: the score just can't be submitted */
    }
  }

  get canSubmitLive() {
    return this.live() && this.token !== null;
  }

  async submit(name: string, score: number, wave: number, durationMs: number): Promise<SubmitResult> {
    name = name.trim();
    if (!name) return { ok: false, error: 'Add a name for the board.', field: 'name' };
    if ([...name].length > MAX_NAME) return { ok: false, error: `Name can be at most ${MAX_NAME} characters.`, field: 'name' };
    try {
      localStorage.setItem('city.guestbook.name', name);
    } catch {
      /* fine */
    }
    if (!this.live()) {
      const rows = [...readLocal(), { name, score, wave, durationMs, at: new Date().toISOString() }];
      if (!writeLocal(rows.slice(-200))) return { ok: false, error: 'This browser blocks local storage, so the demo board can’t save.' };
      const ranked = rankLocal(rows, 1000);
      const rank = ranked.findIndex((r) => r.name.toLowerCase() === name.toLowerCase()) + 1;
      return { ok: true, rank, improved: ranked[rank - 1]?.score === score, best: ranked[rank - 1]?.score ?? score, local: true };
    }
    if (!this.token) return { ok: false, error: 'This run started while the server was unreachable, so it can’t be submitted.' };
    const token = this.token;
    this.token = null; // single use
    try {
      const r = await fetch(`${API_BASE}/api/leaderboard`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ board: BOARD, name, score, wave, durationMs, token }),
      });
      const body = await r.json().catch(() => ({}));
      if (r.ok) return { ok: true, rank: body.rank, improved: body.improved, best: body.best, local: false };
      if (body.field !== 'name') this.token = null;
      else this.token = token; // a rejected name doesn't burn the run
      return { ok: false, error: sentence(body.error ?? `The server refused the score (HTTP ${r.status}).`), field: body.field };
    } catch {
      this.token = token;
      return { ok: false, error: 'Couldn’t reach the server. Check your connection and try again.' };
    }
  }
}

export const defaultName = () => rememberedName();

function sentence(s: string): string {
  s = s.charAt(0).toUpperCase() + s.slice(1);
  return /[.!?]$/.test(s) ? s : s + '.';
}
