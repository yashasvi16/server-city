// Traffic Defense: the playable mini-game, played in 3D on the deck beside
// the island. Rules live in sim.ts, the 3D layer in deck3d.ts; this file is
// the controller: HUD, input (mouse, touch, keyboard) and the run lifecycle.
// Loaded on demand, so visitors who never press Play never download it.
import * as THREE from 'three';
import { esc } from '../experience/chapters';
import { defaultName, type LeaderboardClient } from '../net/leaderboard';
import { MAX_NAME } from '../net/guestbook';
import { DeckView } from './deck3d';
import {
  cacheHitRatio, ERROR_BUDGET, LEVELS, MAX_LEVEL, MAX_WAVE, PADS, Sim, TOWERS, upgradeCost,
  type Tower, type TowerKind,
} from './sim';

const KINDS: TowerKind[] = ['limiter', 'cache', 'lb'];
const ICONS: Record<TowerKind, string> = {
  limiter: '<svg class="td-ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.5 20.2 7.25v9.5L12 21.5 3.8 16.75v-9.5Z" fill="#14173a" stroke="#ffa63d" stroke-width="2"/><rect x="7.5" y="13" width="9" height="2.6" fill="#ffa63d"/></svg>',
  cache: '<svg class="td-ico" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" fill="#14173a" stroke="#ff5a4f" stroke-width="2"/><path d="M12 6.5a5.5 5.5 0 1 1-5.2 3.7" fill="none" stroke="#ff5a4f" stroke-width="2.2"/></svg>',
  lb: '<svg class="td-ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.5 21.5 12 12 21.5 2.5 12Z" fill="#14173a" stroke="#5ff2d3" stroke-width="2"/><circle cx="9" cy="12" r="1.6" fill="#5ff2d3"/><circle cx="15" cy="12" r="1.6" fill="#5ff2d3"/></svg>',
};
const KEYS: Record<string, TowerKind> = { '1': 'limiter', '2': 'cache', '3': 'lb' };

/** What the city gives the game: its scene, camera and frame loop. */
export interface GameHost {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  dom: HTMLCanvasElement;
  /** Fly the camera to the deck and hold it there. */
  enterGame(): void;
  /** Hand the camera back to the tour. */
  leaveGame(): void;
  /** Called every frame of the city loop; returns an unsubscribe function. */
  onFrame(cb: (dt: number, t: number) => void): () => void;
}

export interface DefenseOptions {
  lb: LeaderboardClient;
  host: GameHost;
  /** A score was saved (refresh any leaderboard on the page). */
  onScore(): void;
  onClose(): void;
}

let open: Defense | null = null;

export function openDefense(o: DefenseOptions) {
  if (open) return;
  open = new Defense(o);
}

class Defense {
  private root: HTMLElement;
  private view = new DeckView();
  private ray = new THREE.Raycaster();
  private ndc = new THREE.Vector2();
  private down: { x: number; y: number } | null = null;
  private unsub: () => void = () => {};
  private sim = new Sim((Math.random() * 2 ** 31) | 0);
  private build: TowerKind | null = null;
  private selected: Tower | null = null;
  private cursor = 0; // keyboard pad index
  private hover: [number, number] | null = null;
  private speed = 1;
  private paused = false;
  private startWall = performance.now();
  private toastT = 0;
  private lastHud = '';
  private returnFocus = document.activeElement as HTMLElement | null;
  private ended = false;

  constructor(private o: DefenseOptions) {
    this.root = document.createElement('div');
    this.root.className = 'td';
    this.root.setAttribute('role', 'dialog');
    this.root.setAttribute('aria-modal', 'true');
    this.root.setAttribute('aria-labelledby', 'td-title');
    this.root.innerHTML = `
      <div class="td-head">
        <h2 id="td-title">Traffic Defense</h2>
        <dl class="td-stats" aria-live="off">
          <div><dt>Wave</dt><dd data-k="wave">0/${MAX_WAVE}</dd></div>
          <div><dt>Credits</dt><dd data-k="credits"></dd></div>
          <div><dt>Error budget</dt><dd><span class="td-budget"><span data-k="budgetbar"></span></span><span data-k="budget"></span></dd></div>
          <div><dt>Score</dt><dd data-k="score">0</dd></div>
          <div class="td-wide"><dt>Cloud bill / wave</dt><dd data-k="bill">0</dd></div>
        </dl>
        <div class="td-head-btns">
          <button class="btn td-speed" type="button" aria-pressed="false" title="Speed (F)">2×</button>
          <button class="btn td-help-btn" type="button" aria-expanded="false" aria-controls="td-help">How to play</button>
          <button class="btn td-close" type="button" aria-label="Leave the game">×</button>
        </div>
      </div>
      <div class="td-center">
        <p class="sr-only">The game board is the deck beside the island. Requests travel from the internet gate to the origin data centre. Use the number keys and arrow keys to build, or tap the pads.</p>
        <p class="td-toast" aria-live="polite"></p>
        <div class="td-help" id="td-help" hidden>
          <h3>Keep the servers up</h3>
          <p>Requests travel the road from the internet to your two origin servers. Each server handles one request at a time, and the origin can queue 8. When the queue is full, requests fail and burn your <strong>error budget</strong>. At zero, the run is over.</p>
          <ul>
            <li><strong>Rate limiter.</strong> A token bucket: it drops <span class="k-burst">bot bursts</span> while it has tokens, then refills. Normal users stay under the limit and pass.</li>
            <li><strong>Cache.</strong> Answers <span class="k-get">GETs</span> itself, faster and cheaper. Its hit ratio starts low and rises as it warms up. <span class="k-heavy">Heavy writes</span> can’t be cached.</li>
            <li><strong>Load balancer.</strong> Adds a server beside the road. It serves anything it catches, so unfiltered bots waste it.</li>
          </ul>
          <p>Build on the marked pads, upgrade what works, and mind the cloud bill: every tower costs credits each wave.</p>
          <p class="td-keys">Keys: <kbd>1</kbd> <kbd>2</kbd> <kbd>3</kbd> pick a tower · <kbd>←</kbd> <kbd>→</kbd> move between pads · <kbd>Enter</kbd> build or select · <kbd>U</kbd> upgrade · <kbd>S</kbd> sell · <kbd>Space</kbd> send the wave · <kbd>F</kbd> speed · <kbd>Esc</kbd> leave</p>
          <button class="btn primary td-help-close" type="button">Got it</button>
        </div>
        <div class="td-modal" hidden></div>
      </div>
      <div class="td-foot">
        <div class="td-palette" role="group" aria-label="Towers">
          ${KINDS.map((k, i) => `<button class="td-tool" type="button" data-kind="${k}" data-cost="${TOWERS[k].cost} cr" aria-pressed="false">
            ${ICONS[k]}
            <span class="td-tool-txt"><strong>${esc(TOWERS[k].name)}</strong><span>${TOWERS[k].cost} cr · ${esc(TOWERS[k].blurb)}</span></span>
            <kbd aria-hidden="true">${i + 1}</kbd></button>`).join('')}
        </div>
        <div class="td-inspect" hidden></div>
        <button class="btn primary td-go" type="button">Send wave 1</button>
      </div>`;
    document.getElementById('city-view')!.appendChild(this.root);
    document.body.classList.add('td-open');
    this.o.host.scene.add(this.view.group);
    this.o.host.enterGame();
    void this.o.lb.start();
    this.wire();
    if (!sessionStorageSeen()) this.toggleHelp(true);
    (this.root.querySelector('.td-go') as HTMLButtonElement).focus({ preventScroll: true });
    this.unsub = this.o.host.onFrame(this.frame);
    (window as unknown as { __td?: unknown }).__td = this; // for automated checks
  }

  // ── wiring ────────────────────────────────────────────────────────────────
  private wire() {
    const r = this.root;
    r.querySelector('.td-close')!.addEventListener('click', () => this.askLeave());
    r.querySelector('.td-speed')!.addEventListener('click', () => this.toggleSpeed());
    r.querySelector('.td-help-btn')!.addEventListener('click', () => this.toggleHelp());
    r.querySelector('.td-help-close')!.addEventListener('click', () => this.toggleHelp(false));
    r.querySelector('.td-go')!.addEventListener('click', () => this.sendWave());
    r.querySelectorAll<HTMLButtonElement>('.td-tool').forEach((b) =>
      b.addEventListener('click', () => this.pick(b.dataset.kind as TowerKind)));
    r.querySelector('.td-inspect')!.addEventListener('click', (e) => {
      const act = (e.target as HTMLElement).closest<HTMLButtonElement>('button')?.dataset.act;
      if (act === 'up') this.upgrade();
      if (act === 'sell') this.sell();
      if (act === 'deselect') this.select(null);
    });
    const dom = this.o.host.dom;
    dom.addEventListener('pointerdown', this.onDown);
    dom.addEventListener('pointerup', this.onUp);
    dom.addEventListener('pointermove', this.onMove);
    dom.addEventListener('pointerleave', this.onLeave);
    addEventListener('keydown', this.onKey);
    document.addEventListener('visibilitychange', this.onVis);
  }

  private cellAt(e: PointerEvent): [number, number] | null {
    const r = this.o.host.dom.getBoundingClientRect();
    this.ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    this.ray.setFromCamera(this.ndc, this.o.host.camera);
    return this.view.pick(this.ray.ray);
  }
  private onDown = (e: PointerEvent) => (this.down = { x: e.clientX, y: e.clientY });
  private onUp = (e: PointerEvent) => {
    if (!this.down || Math.hypot(e.clientX - this.down.x, e.clientY - this.down.y) > 10) return;
    this.down = null;
    const cell = this.cellAt(e);
    if (cell) this.tapCell(cell[0], cell[1]);
  };
  private onMove = (e: PointerEvent) => {
    this.hover = e.pointerType === 'mouse' ? this.cellAt(e) : null;
    this.o.host.dom.style.cursor = this.hover && PADS.some(([c, r]) => c === this.hover![0] && r === this.hover![1]) ? 'pointer' : '';
  };
  private onLeave = () => (this.hover = null);
  private keyCursor = false;

  private onVis = () => {
    if (document.hidden && !this.ended) this.paused = true;
    else if (!document.hidden && !this.modalOpen()) this.paused = false;
  };

  private onKey = (e: KeyboardEvent) => {
    if ((e.target as HTMLElement).closest('input, textarea, a')) return;
    const k = e.key;
    if (k === 'Escape') {
      e.preventDefault();
      if (!this.helpEl.hidden) this.toggleHelp(false);
      else if (this.modalOpen() && !this.ended) this.resume();
      else this.askLeave();
      return;
    }
    if (this.modalOpen() || !this.helpEl.hidden) return;
    if (KEYS[k]) this.pick(KEYS[k]);
    else if (k === 'ArrowRight' || k === 'ArrowDown') this.moveCursor(1, e);
    else if (k === 'ArrowLeft' || k === 'ArrowUp') this.moveCursor(-1, e);
    else if (k === 'Enter' && this.keyCursor && !(e.target as HTMLElement).closest('button')) this.tapCell(...PADS[this.cursor]);
    else if (k === ' ' && !(e.target as HTMLElement).closest('button')) {
      e.preventDefault();
      this.sendWave();
    } else if (k === 'u' || k === 'U') this.upgrade();
    else if (k === 's' || k === 'S') this.sell();
    else if (k === 'f' || k === 'F') this.toggleSpeed();
  };

  private moveCursor(d: number, e: KeyboardEvent) {
    e.preventDefault();
    if (this.keyCursor) this.cursor = (this.cursor + d + PADS.length) % PADS.length;
    this.keyCursor = true;
    const [c, r] = PADS[this.cursor];
    const t = this.towerAt(c, r);
    this.say(t ? `${TOWERS[t.kind].name}, level ${t.level}` : `Empty pad ${this.cursor + 1} of ${PADS.length}`);
  }

  private get helpEl() {
    return this.root.querySelector<HTMLElement>('.td-help')!;
  }
  private get modal() {
    return this.root.querySelector<HTMLElement>('.td-modal')!;
  }
  private modalOpen() {
    return !this.modal.hidden;
  }

  private toggleHelp(show: boolean = !!this.helpEl.hidden) {
    this.helpEl.hidden = !show;
    this.root.querySelector('.td-help-btn')!.setAttribute('aria-expanded', String(show));
    this.paused = show || this.modalOpen();
    if (show) (this.helpEl.querySelector('.td-help-close') as HTMLElement).focus({ preventScroll: true });
    else {
      markSeen();
      (this.root.querySelector('.td-go') as HTMLElement).focus({ preventScroll: true });
    }
  }

  private toggleSpeed() {
    this.speed = this.speed === 1 ? 2 : 1;
    this.root.querySelector('.td-speed')!.setAttribute('aria-pressed', String(this.speed === 2));
  }

  private pick(k: TowerKind) {
    this.build = this.build === k ? null : k;
    this.select(null);
    this.root.querySelectorAll<HTMLButtonElement>('.td-tool').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.kind === this.build)));
    if (this.build) this.say(`${TOWERS[this.build].name}: tap a pad to build (${TOWERS[this.build].cost} credits).`);
  }

  private towerAt(c: number, r: number) {
    return this.sim.towers.find((t) => t.c === c && t.r === r) ?? null;
  }

  private tapCell(c: number, r: number) {
    if (this.ended || this.modalOpen()) return;
    const t = this.towerAt(c, r);
    const padIdx = PADS.findIndex(([pc, pr]) => pc === c && pr === r);
    if (padIdx >= 0) this.cursor = padIdx;
    if (t) return this.select(this.selected === t ? null : t);
    if (padIdx < 0) return this.select(null);
    if (!this.build) return this.say('Pick a tower below, then tap a pad.');
    const res = this.sim.place(this.build, c, r);
    if (typeof res === 'string') return this.say(res);
    this.say(`${TOWERS[res.kind].name} built.`);
  }

  private select(t: Tower | null) {
    this.selected = t;
    const el = this.root.querySelector<HTMLElement>('.td-inspect')!;
    const pal = this.root.querySelector<HTMLElement>('.td-palette')!;
    el.hidden = !t;
    pal.hidden = !!t;
    this.renderInspect();
  }

  private renderInspect() {
    const t = this.selected;
    const el = this.root.querySelector<HTMLElement>('.td-inspect')!;
    if (!t) return;
    const L = t.level - 1;
    const detail = t.kind === 'limiter'
      ? `Bucket ${LEVELS.limiter.capacity[L]} tokens, refills ${LEVELS.limiter.refill[L]}/s`
      : t.kind === 'cache'
        ? `Hit ratio ${Math.round(cacheHitRatio(t) * 100)}% now (up to ${Math.round(LEVELS.cache.maxHit[L] * 100)}% when warm), ${t.hits} hits`
        : `${LEVELS.lb.workers[L]} server${L ? 's' : ''}, queue ${LEVELS.lb.queue[L]}`;
    const why = this.sim.canUpgrade(t);
    el.innerHTML = `
      <div class="td-inspect-txt"><strong>${esc(TOWERS[t.kind].name)} · level ${t.level}/${MAX_LEVEL}</strong><span>${esc(detail)}. Bill ${TOWERS[t.kind].upkeep * t.level}/wave.</span></div>
      <button class="btn" type="button" data-act="up" ${why ? 'disabled' : ''} title="Upgrade (U)">${t.level >= MAX_LEVEL ? 'Max level' : `Upgrade · ${upgradeCost(t)}`}</button>
      <button class="btn" type="button" data-act="sell" title="Sell (S)">Sell · +${Math.floor(t.spent * 0.6)}</button>
      <button class="btn" type="button" data-act="deselect" aria-label="Done">Done</button>`;
  }

  private upgrade() {
    if (!this.selected) return;
    const why = this.sim.upgrade(this.selected.id);
    this.say(why ?? `${TOWERS[this.selected.kind].name} upgraded to level ${this.selected.level}.`);
    this.renderInspect();
  }

  private sell() {
    if (!this.selected) return;
    const refund = this.sim.sell(this.selected.id);
    this.say(`Sold for ${refund} credits.`);
    this.select(null);
  }

  private sendWave() {
    if (this.ended || this.modalOpen()) return;
    if (this.sim.state !== 'build') return this.say('A wave is already running.');
    const bill = this.sim.bill;
    this.sim.startWave();
    this.say(`Wave ${this.sim.wave}${bill ? `. Cloud bill: ${this.sim.lastBill} credits` : ''}.`);
  }

  private say(s: string) {
    this.toastT = 2.6;
    const el = this.root.querySelector<HTMLElement>('.td-toast')!;
    el.textContent = s;
    el.classList.add('show');
  }

  // ── leaving and finishing ─────────────────────────────────────────────────
  private askLeave() {
    if (this.ended || (this.sim.wave === 0 && !this.sim.towers.length)) return this.close();
    this.paused = true;
    this.modal.hidden = false;
    this.modal.innerHTML = `
      <h3>Leave this run?</h3>
      <p>You’re on wave ${this.sim.wave} with ${this.sim.score.toLocaleString('en-US')} points. Leaving ends the run without saving it.</p>
      <div class="td-actions">
        <button class="btn primary" type="button" data-act="resume">Keep playing</button>
        <button class="btn" type="button" data-act="end">End and save score</button>
        <button class="btn" type="button" data-act="quit">Leave without saving</button>
      </div>`;
    this.modal.onclick = (e) => {
      const act = (e.target as HTMLElement).closest<HTMLButtonElement>('button')?.dataset.act;
      if (act === 'resume') this.resume();
      if (act === 'quit') this.close();
      if (act === 'end') this.finish('ended');
    };
    (this.modal.querySelector('button') as HTMLElement).focus({ preventScroll: true });
  }

  private resume() {
    this.modal.hidden = true;
    this.modal.onclick = null;
    this.paused = !this.helpEl.hidden;
    (this.root.querySelector('.td-go') as HTMLElement).focus({ preventScroll: true });
  }

  private finish(how: 'over' | 'won' | 'ended') {
    if (this.ended) return;
    this.ended = true;
    this.paused = true;
    const s = this.sim;
    const wave = Math.max(1, s.wave);
    const durationMs = Math.round(performance.now() - this.startWall);
    const live = this.o.lb.isLive;
    const canSave = s.score > 0 && (!live || this.o.lb.canSubmitLive);
    const title = how === 'won' ? 'All 50 waves held.' : how === 'over' ? 'Error budget spent.' : 'Run ended.';
    this.modal.hidden = false;
    this.modal.innerHTML = `
      <h3>${title}</h3>
      <p class="td-final"><strong>${s.score.toLocaleString('en-US')}</strong> points · wave ${wave} · ${s.served.toLocaleString('en-US')} requests served · ${s.errors} failed</p>
      ${canSave ? `
        <form class="td-save" novalidate>
          <label for="td-name">Name for the leaderboard</label>
          <div class="td-row">
            <input id="td-name" name="name" maxlength="${MAX_NAME}" autocomplete="nickname" value="${esc(defaultName())}" required />
            <button class="btn primary" type="submit">Save score</button>
          </div>
          <p class="td-msg" role="status">${live ? '' : 'The backend isn’t running here, so this board is saved in this browser only.'}</p>
        </form>` : `<p class="td-msg">${s.score === 0 ? 'No points this time.' : 'This run started while the server was unreachable, so it can’t go on the board.'}</p>`}
      <div class="td-actions">
        <button class="btn" type="button" data-act="again">Play again</button>
        <button class="btn" type="button" data-act="quit">Back to the city</button>
      </div>`;
    const form = this.modal.querySelector<HTMLFormElement>('.td-save');
    const msg = this.modal.querySelector<HTMLElement>('.td-msg')!;
    form?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = form.querySelector<HTMLButtonElement>('button')!;
      const name = (form.elements.namedItem('name') as HTMLInputElement).value;
      btn.disabled = true;
      msg.textContent = 'Saving…';
      const r = await this.o.lb.submit(name, s.score, wave, durationMs);
      if (r.ok) {
        msg.textContent = `${r.local ? 'Saved in this browser. ' : 'Saved. '}${r.rank ? `You’re #${r.rank} on the board` : 'Not in the top scores yet'}${r.improved ? '' : `; your best is still ${r.best.toLocaleString('en-US')}`}.`;
        form.querySelector('.td-row')!.remove();
        this.o.onScore();
      } else {
        msg.textContent = r.error;
        btn.disabled = false;
        if (r.field === 'name') (form.elements.namedItem('name') as HTMLInputElement).focus();
      }
    });
    this.modal.onclick = (e) => {
      const act = (e.target as HTMLElement).closest<HTMLButtonElement>('button')?.dataset.act;
      if (act === 'quit') this.close();
      if (act === 'again') this.restart();
    };
    ((form?.querySelector('input') ?? this.modal.querySelector('button')) as HTMLElement).focus({ preventScroll: true });
  }

  private restart() {
    this.sim = new Sim((Math.random() * 2 ** 31) | 0);
    this.ended = false;
    this.startWall = performance.now();
    this.select(null);
    this.build = null;
    this.root.querySelectorAll('.td-tool').forEach((b) => b.setAttribute('aria-pressed', 'false'));
    void this.o.lb.start();
    this.resume();
  }

  private close() {
    this.unsub();
    document.removeEventListener('visibilitychange', this.onVis);
    removeEventListener('keydown', this.onKey);
    const dom = this.o.host.dom;
    dom.removeEventListener('pointerdown', this.onDown);
    dom.removeEventListener('pointerup', this.onUp);
    dom.removeEventListener('pointermove', this.onMove);
    dom.removeEventListener('pointerleave', this.onLeave);
    dom.style.cursor = '';
    this.view.dispose();
    this.root.remove();
    document.body.classList.remove('td-open');
    this.o.host.leaveGame();
    open = null;
    this.o.onClose();
    this.returnFocus?.focus?.({ preventScroll: true });
  }

  // ── loop ──────────────────────────────────────────────────────────────────
  private frame = (dtRaw: number, t: number) => {
    const dt = Math.min(dtRaw, 0.05);
    if (!this.paused) {
      for (let i = 0; i < this.speed; i++) this.sim.step(dt);
    }
    for (const e of this.sim.events) {
      if (e.t === 'over' || e.t === 'won') this.finish(e.t);
      else if (e.t === 'wave') this.say(`Wave ${e.wave} held. +${e.bonus} points.`);
      else this.view.event(e);
    }
    this.sim.events.length = 0;
    if (this.toastT > 0 && (this.toastT -= dt) <= 0) this.root.querySelector('.td-toast')!.classList.remove('show');
    this.hud();
    const cursor = this.keyCursor ? PADS[this.cursor] : this.hover;
    this.view.update(this.sim, {
      selected: this.selected, build: this.build, cursor,
      canAfford: !!this.build && this.sim.credits >= TOWERS[this.build].cost,
    }, this.paused ? 0 : dt * this.speed, t);
  };

  private hud() {
    const s = this.sim;
    const key = [s.wave, s.credits, s.budget, s.score, s.bill, s.state, this.selected?.level, this.selected && this.sim.canUpgrade(this.selected)].join('|');
    if (key === this.lastHud) return;
    this.lastHud = key;
    const set = (k: string, v: string) => (this.root.querySelector(`[data-k="${k}"]`)!.textContent = v);
    set('wave', `${s.wave}/${MAX_WAVE}`);
    set('credits', String(Math.floor(s.credits)));
    set('budget', ` ${s.budget}`);
    set('score', s.score.toLocaleString('en-US'));
    set('bill', String(s.bill));
    const bar = this.root.querySelector<HTMLElement>('[data-k="budgetbar"]')!;
    bar.style.width = `${(s.budget / ERROR_BUDGET) * 100}%`;
    bar.classList.toggle('low', s.budget <= 6);
    const go = this.root.querySelector<HTMLButtonElement>('.td-go')!;
    go.disabled = s.state !== 'build';
    go.textContent = s.state === 'wave' ? `Wave ${s.wave} incoming` : s.state === 'build' ? `Send wave ${s.wave + 1}` : 'Run over';
    this.root.querySelectorAll<HTMLButtonElement>('.td-tool').forEach((b) => b.classList.toggle('poor', s.credits < TOWERS[b.dataset.kind as TowerKind].cost));
    if (this.selected) {
      if (!s.towers.includes(this.selected)) this.select(null);
      else this.renderInspect();
    }
  }

}

const SEEN = 'city.defense.help';
function sessionStorageSeen(): boolean {
  try {
    return localStorage.getItem(SEEN) === '1';
  } catch {
    return false;
  }
}
function markSeen() {
  try {
    localStorage.setItem(SEEN, '1');
  } catch {
    /* fine */
  }
}
