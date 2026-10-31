// Builds the tour's chapters (real, accessible document sections) from
// site.config.ts. The 3D camera follows whichever chapter is on screen.
import { site } from '../config/site.config';
import type { Project } from '../config/types';

export const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const link = (url: string, label: string, cls = 'btn') =>
  `<a class="${cls}" href="${esc(url)}" target="_blank" rel="noopener">${esc(label)}</a>`;

function projectChapter(p: Project, i: number, n: number): string {
  const facts = p.highlights.slice(0, 3);
  const src = p.links?.[0];
  const isPool = p.district.kind === 'poolhall';
  return `
  <section class="chapter" id="${esc(p.id)}" data-landmark="${esc(p.id)}" aria-labelledby="h-${esc(p.id)}">
    <div class="chapter-body">
      <p class="count"><span>${i + 1}/${n}</span><span class="place">${esc(p.district.name)}</span></p>
      <h2 id="h-${esc(p.id)}">${esc(p.title)}</h2>
      <p class="tagline">${esc(p.tagline)}</p>
      <p class="stack">${p.stack.map(esc).join('  /  ')}</p>
      <ul class="facts">${facts.map((f) => `<li>${esc(f)}</li>`).join('')}</ul>
      <div class="actions">
        ${p.flows?.length ? `<button class="btn primary" type="button" data-act="flows" aria-expanded="false" aria-controls="fp-${esc(p.id)}">Watch a request</button>` : ''}
        ${isPool ? `<button class="btn primary" type="button" data-act="shot">Take a shot</button>` : ''}
        <button class="btn" type="button" data-act="writeup">Read the write-up</button>
        ${src ? link(src.url, 'Source') : ''}
        ${p.video ? link(p.video, 'Video') : ''}
      </div>
      ${p.sourceNote ? `<p class="note">${esc(p.sourceNote)}</p>` : ''}
      ${p.flows?.length ? `
        <div class="flow-picker" id="fp-${esc(p.id)}" hidden>
          ${p.flows.map((f, k) => `<button class="btn" type="button" data-flow="${k}" aria-pressed="false"><span class="dot ${f.outcome}" aria-hidden="true"></span>${esc(f.name)}</button>`).join('')}
        </div>
        <ol class="steps" aria-live="polite"></ol>` : ''}
    </div>
  </section>`;
}

export function renderTour(host: HTMLElement) {
  const pr = site.profile;
  const n = site.projects.length;
  const e = site.experience[0];
  // First sentence of the intro leads the hero; the rest closes the tour.
  const [lede, ...rest] = pr.intro.split(/(?<=\.)\s+/);
  host.innerHTML = `
  <section class="chapter hero" id="top" data-landmark="hero" aria-labelledby="hero-title">
    <div class="chapter-body">
      <h1 id="hero-title">${esc(pr.name)}</h1>
      <p class="lede">${esc(lede)}</p>
      <p class="sub">This island is a running system. Every building is a project, every moving light is a request, and the people on the streets are other visitors, connected to a Go server right now.</p>
      <span class="scroll-cue">Scroll to tour the city</span>
    </div>
  </section>
  ${site.projects.map((p, i) => projectChapter(p, i, n)).join('')}
  <section class="chapter" id="defense" data-landmark="defense" aria-labelledby="h-defense">
    <div class="chapter-body">
      <p class="count"><span>Mini-game</span><span class="place">Traffic Defense</span></p>
      <h2 id="h-defense">Keep the servers up</h2>
      <p class="tagline">On the deck beside the island, waves of traffic cross the bridge from the city toward two origin servers. Keep them up with the same tools a real backend uses.</p>
      <ul class="facts">
        <li><strong>Rate limiters</strong> are token buckets: they drop bot bursts and let normal users through.</li>
        <li><strong>Caches</strong> answer repeat GETs and get better as they warm up. Heavy writes can’t be cached.</li>
        <li><strong>Load balancers</strong> add servers, but they’ll serve bots too unless you filter first.</li>
      </ul>
      <div class="actions">
        <button class="btn primary" type="button" data-act="play">Play</button>
      </div>
      <h3 class="lb-title">Leaderboard <span class="lb-mode"></span></h3>
      <ol class="lb-list" aria-live="polite"><li class="lb-empty">Loading…</li></ol>
      <p class="note lb-note">Scores are checked on the server: each run gets a signed, single-use token, and a score that couldn’t come from a real run of that length is refused.</p>
    </div>
  </section>
  <section class="chapter" id="guestbook" data-landmark="guestbook" aria-labelledby="h-guestbook">
    <div class="chapter-body">
      <p class="count"><span>Guestbook</span><span class="place">Lantern garden</span></p>
      <h2 id="h-guestbook">Leave a lantern</h2>
      <p class="tagline">Every message becomes a lantern that floats around the island for everyone who visits.</p>
      <div id="gb-mount"></div>
    </div>
  </section>
  <section class="chapter" id="about" data-landmark="about" aria-labelledby="h-about">
    <div class="chapter-body">
      <h2 id="h-about">Let's build something that stays up.</h2>
      <p class="tagline">${esc(rest.join(' ') || pr.intro)}</p>
      <div class="about-grid">
        ${e ? `<div><h3>Experience</h3><p>${esc(e.role)}, ${esc(e.org)}, ${esc(e.place)}. ${esc(e.period)}.</p>${e.points.length ? `<p>${esc(e.points[0])}</p>` : ''}</div>` : ''}
        <div><h3>Education</h3><p>${esc(site.education.degree)}, ${esc(site.education.school)}, ${esc(site.education.period)}${site.education.grade ? `. ${esc(site.education.grade)}` : ''}.</p></div>
        <div><h3>Also</h3><ul>${site.achievements.map((a) => `<li>${esc(a)}</li>`).join('')}</ul></div>
        <div><h3>Looking for</h3><p>${esc(pr.targetRoles)}.</p></div>
      </div>
      <p class="contact">
        <span class="email">${esc(pr.email)}</span>
      </p>
      <div class="actions">
        <a class="btn primary" href="mailto:${esc(pr.email)}">Email me</a>
        ${link(pr.links.github, 'GitHub')}
        ${pr.links.linkedin ? link(pr.links.linkedin, 'LinkedIn') : ''}
        <a class="btn" href="${(document.querySelector('.resume-btn') as HTMLAnchorElement)?.getAttribute('href') ?? './resume.html'}">Plain resume</a>
      </div>
    </div>
  </section>`;
  return [...host.querySelectorAll<HTMLElement>('section.chapter')];
}

/** Full write-up for the sheet. */
export function writeupHTML(p: Project): string {
  const links = [...(p.links ?? []), ...(p.video ? [{ label: 'Video demo', url: p.video }] : [])];
  return `
    <button class="close" type="button" aria-label="Close">×</button>
    <h2 id="sheet-title" tabindex="-1">${esc(p.title)}</h2>
    <p>${esc(p.tagline)}</p>
    <p class="stack">${p.stack.map(esc).join('  /  ')}</p>
    ${links.length ? `<div class="links">${links.map((l) => link(l.url, l.label)).join('')}</div>` : ''}
    ${p.sourceNote ? `<p class="source-note">${esc(p.sourceNote)}</p>` : ''}
    <p>${esc(p.summary)}</p>
    <h3>What it does</h3>
    <ul>${p.highlights.map((h) => `<li>${esc(h)}</li>`).join('')}</ul>
    <h3>Architecture</h3>
    ${p.architecture.map((a) => `<p>${esc(a)}</p>`).join('')}
    ${p.tradeoffs ? `<h3>Tradeoffs</h3><ul>${p.tradeoffs.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>` : ''}
    ${p.wouldChange ? `<h3>What I would change</h3><p>${esc(p.wouldChange)}</p>` : ''}`;
}
