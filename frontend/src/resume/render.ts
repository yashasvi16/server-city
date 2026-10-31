// Renders the plain resume as static HTML from site.config.ts.
// Runs at build time (vite plugin) so resume.html works with JS disabled.
import type { Project, SiteConfig } from '../config/types';

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const a = (url: string, label: string) => `<a href="${esc(url)}" rel="noopener">${esc(label)}</a>`;

function project(p: Project): string {
  const links = [...(p.links ?? []), ...(p.video ? [{ label: 'Video demo', url: p.video }] : [])];
  return `
<article class="project" id="${esc(p.id)}">
  <h3>${esc(p.title)}</h3>
  <p class="tagline">${esc(p.tagline)}</p>
  <p class="stack"><span class="sr">Stack: </span>${p.stack.map(esc).join(', ')}</p>
  ${links.length ? `<p class="links">${links.map((l) => a(l.url, l.label)).join(' ')}</p>` : ''}
  ${p.sourceNote ? `<p class="meta">${esc(p.sourceNote)}</p>` : ''}
  <p>${esc(p.summary)}</p>
  <ul>${p.highlights.map((h) => `<li>${esc(h)}</li>`).join('')}</ul>
  <details>
    <summary>Architecture, tradeoffs and what I would change</summary>
    <h4>Architecture</h4>
    ${p.architecture.map((t) => `<p>${esc(t)}</p>`).join('')}
    ${p.tradeoffs ? `<h4>Tradeoffs</h4><ul>${p.tradeoffs.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>` : ''}
    ${p.wouldChange ? `<h4>What I would change</h4><p>${esc(p.wouldChange)}</p>` : ''}
  </details>
</article>`;
}

/** The resume body (no <html>/<head>), shared by resume.html and the
 *  single-file build's #resume view. */
export function renderResumeBody(c: SiteConfig, cityHref: string): string {
  const { profile: pr } = c;
  const contact = [
    a(`mailto:${pr.email}`, pr.email),
    a(pr.links.github, 'GitHub'),
    pr.links.linkedin ? a(pr.links.linkedin, 'LinkedIn') : '',
    pr.links.portfolio ? a(pr.links.portfolio, 'Portfolio') : '',
  ].filter(Boolean);

  return `
<a class="skip" href="#main">Skip to content</a>
<header class="masthead">
  <div>
    <h1>${esc(pr.name)}</h1>
    <p class="role">${esc(pr.role)}</p>
    <p class="meta">${esc(pr.location)}</p>
    <p class="contact">${contact.join(' ')}</p>
  </div>
  <a class="tocity" href="${esc(cityHref)}">Open the 3D city</a>
</header>
<main id="main">
  <section aria-labelledby="about"><h2 id="about">About</h2>
    <p>${esc(pr.intro)}</p>
    <p>Looking for: ${esc(pr.targetRoles)}.</p>
  </section>
  <section aria-labelledby="projects"><h2 id="projects">Projects</h2>
    ${c.projects.map(project).join('')}
  </section>
  <section aria-labelledby="exp"><h2 id="exp">Experience</h2>
    ${c.experience
      .map(
        (e) => `<article class="job"><h3>${esc(e.role)}, ${esc(e.org)}</h3>
      <p class="meta">${esc(e.place)}, ${esc(e.period)}</p>
      <ul>${e.points.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></article>`,
      )
      .join('')}
  </section>
  <section aria-labelledby="edu"><h2 id="edu">Education</h2>
    <p><strong>${esc(c.education.degree)}</strong>, ${esc(c.education.school)}, ${esc(c.education.period)}${
      c.education.grade ? `. ${esc(c.education.grade)}` : ''
    }</p>
  </section>
  <section aria-labelledby="ach"><h2 id="ach">Achievements</h2>
    <ul>${c.achievements.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>
  </section>
  <section aria-labelledby="other"><h2 id="other">Other work</h2>
    <ul>${c.otherWork
      .map((o) => `<li><strong>${esc(o.title)}</strong>${o.text ? `. ${esc(o.text)}` : ''}${o.links?.length ? ` ${o.links.map((l) => a(l.url, l.label)).join(' ')}` : ''}</li>`)
      .join('')}</ul>
  </section>
</main>
<footer class="foot"><p>This page has the same content as the 3D city and needs no JavaScript.</p></footer>`;
}

/** Lists every TBD so the build can warn about it. */
export function listTBD(c: SiteConfig): string[] {
  const out: string[] = [];
  if (!c.profile.links.linkedin) out.push('profile.links.linkedin');
  if (!c.profile.links.portfolio) out.push('profile.links.portfolio');
  if (!c.education.grade) out.push('education.grade');
  for (const p of c.projects) {
    if (!p.links && !p.sourceNote) out.push(`${p.id}.links`);
    if (!p.video) out.push(`${p.id}.video`);
    if (!p.tradeoffs) out.push(`${p.id}.tradeoffs`);
    if (!p.wouldChange) out.push(`${p.id}.wouldChange`);
  }
  return out;
}

/** Guards against a phone number slipping into the published config. */
export function findPhoneNumbers(c: SiteConfig): string[] {
  const text = JSON.stringify(c);
  return text.match(/(?:\+?91[\s-]?)?[6-9]\d{4}[\s-]?\d{5}\b/g) ?? [];
}
