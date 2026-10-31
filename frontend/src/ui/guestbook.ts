import { GuestbookClient, MAX_MESSAGE, MAX_NAME, rememberedName, type Entry } from '../net/guestbook';

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
function ago(iso: string): string {
  const s = (Date.parse(iso) - Date.now()) / 1000, a = Math.abs(s);
  if (a < 60) return 'just now';
  if (a < 3600) return rtf.format(Math.round(s / 60), 'minute');
  if (a < 86400) return rtf.format(Math.round(s / 3600), 'hour');
  if (a < 86400 * 30) return rtf.format(Math.round(s / 86400), 'day');
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}
const entryHTML = (e: Entry) => `<li data-id="${esc(e.id)}"><p class="gb-msg">${esc(e.message)}</p>
  <p class="gb-meta">${esc(e.name)}, <time datetime="${esc(e.at)}">${ago(e.at)}</time>${e.local ? ', saved in this browser only' : ''}</p></li>`;

/** Sign form plus recent messages, mounted into any container. */
export class GuestbookView {
  private list: HTMLUListElement | null = null;
  private shown = new Set<string>();
  private root: HTMLElement | null = null;

  constructor(private client: GuestbookClient, private onPosted: (e: Entry) => void, private onLoaded: (n: number) => void) {}

  async mount(root: HTMLElement) {
    this.root = root;
    const live = this.client.isLive;
    root.innerHTML = `
      ${live ? '' : `<p class="gb-note">The backend isn't running here, so your lantern is saved in this browser only. Nobody else will see it.</p>`}
      <form class="gb-form" novalidate>
        <label for="gb-name">Your name (optional)</label>
        <input id="gb-name" name="name" maxlength="${MAX_NAME}" autocomplete="nickname" value="${esc(rememberedName())}">
        <label for="gb-message">Message</label>
        <textarea id="gb-message" name="message" rows="3" maxlength="${MAX_MESSAGE}" required aria-describedby="gb-count gb-error"></textarea>
        <div class="gb-row"><span id="gb-count" class="gb-count">0 / ${MAX_MESSAGE}</span><button class="btn primary" type="submit">Light a lantern</button></div>
        <p id="gb-error" class="gb-error" role="alert" hidden></p>
      </form>
      <ul class="gb-list" aria-label="Recent messages"><li class="gb-empty">Loading messages…</li></ul>`;
    this.list = root.querySelector('.gb-list');
    this.shown.clear();
    const form = root.querySelector('form')!;
    const msg = form.querySelector('textarea')!;
    const count = form.querySelector('#gb-count')!;
    const err = form.querySelector<HTMLParagraphElement>('#gb-error')!;
    const btn = form.querySelector('button')!;
    msg.addEventListener('input', () => (count.textContent = `${[...msg.value].length} / ${MAX_MESSAGE}`));
    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      err.hidden = true;
      form.querySelectorAll('[aria-invalid]').forEach((el) => el.removeAttribute('aria-invalid'));
      btn.disabled = true;
      btn.textContent = 'Lighting…';
      const res = await this.client.post((form.querySelector('#gb-name') as HTMLInputElement).value, msg.value);
      btn.disabled = false;
      btn.textContent = 'Light a lantern';
      if (!res.ok) {
        err.textContent = res.error;
        err.hidden = false;
        const el = form.querySelector<HTMLElement>(res.field === 'name' ? '#gb-name' : '#gb-message');
        el?.setAttribute('aria-invalid', 'true');
        el?.focus();
        return;
      }
      msg.value = '';
      count.textContent = `0 / ${MAX_MESSAGE}`;
      this.prepend(res.entry);
      this.onPosted(res.entry);
    });
    try {
      const entries = await this.client.list();
      if (this.root !== root || !this.list) return;
      this.list.innerHTML = entries.length ? '' : `<li class="gb-empty">No lanterns yet. Yours can be the first.</li>`;
      for (const e of entries) {
        this.shown.add(e.id);
        this.list.insertAdjacentHTML('beforeend', entryHTML(e));
      }
      this.onLoaded(entries.length);
    } catch {
      if (this.list) this.list.innerHTML = `<li class="gb-empty">Couldn't load messages. Reload the page to try again.</li>`;
    }
  }

  /** Adds an entry at the top (own post or live broadcast), once. */
  prepend(e: Entry): boolean {
    if (!this.list || this.shown.has(e.id)) return false;
    this.shown.add(e.id);
    this.list.querySelector('.gb-empty')?.remove();
    this.list.insertAdjacentHTML('afterbegin', entryHTML(e));
    return true;
  }
}
