// Boot: tiny on purpose. Decides between the plain resume and the city,
// starts the backend probe, then lazy-loads three.js and the world.
import { BootLog } from './experience/loader';
import { probeBackend } from './net/backend';

const resumeView = document.getElementById('resume-view'); // only in the single-file build
const resumeHref = (document.querySelector('.resume-btn') as HTMLAnchorElement).href;

function showResume() {
  document.body.classList.add('show-resume');
  resumeView!.hidden = false;
  document.title = document.title.replace('backend engineer', 'resume');
  scrollTo(0, 0);
}

function webglOK(): boolean {
  try {
    const c = document.createElement('canvas');
    return !!c.getContext('webgl2');
  } catch {
    return false;
  }
}

async function fonts(timeout: number) {
  if (!document.fonts) return;
  await Promise.race([
    Promise.all([
      document.fonts.load("700 64px 'Unbounded Variable'"),
      document.fonts.load("400 16px 'IBM Plex Sans'"),
      document.fonts.load("400 16px 'IBM Plex Mono'"),
    ]).catch(() => undefined),
    new Promise((r) => setTimeout(r, timeout)),
  ]);
}

async function boot() {
  if (resumeView) {
    // Single-file build: the resume lives in this page at #resume. Handle the
    // links directly (the tour rewrites the hash while scrolling, so relying
    // on hashchange would race with it).
    document.addEventListener('click', (e) => {
      const a = (e.target as HTMLElement).closest('a[href="#resume"]');
      if (!a) return;
      e.preventDefault();
      history.replaceState(null, '', '#resume');
      location.reload();
    });
    addEventListener('hashchange', () => {
      if ((location.hash === '#resume') !== document.body.classList.contains('show-resume')) location.reload();
    });
    if (location.hash === '#resume') return showResume();
  }
  const log = new BootLog(6);
  if (!webglOK()) {
    log.fail('WebGL 2 is not available');
    document.getElementById('boot-log')!.insertAdjacentHTML('beforeend',
      `<li><a href="${resumeHref}">Read the plain resume instead</a></li>`);
    return;
  }
  history.scrollRestoration = 'manual';
  const firstProbe = probeBackend(); // runs while three.js downloads
  const t0 = performance.now();
  await fonts(1200);
  log.done('load fonts', `${Math.round(performance.now() - t0)} ms`);
  try {
    const t1 = performance.now();
    const { startExperience } = await import('./experience/app');
    log.done('import three.js + scene', `${Math.round(performance.now() - t1)} ms`);
    await startExperience(log, firstProbe);
  } catch (err) {
    console.error(err);
    log.fail('the city failed to start');
    document.getElementById('boot-log')!.insertAdjacentHTML('beforeend',
      `<li><a href="${resumeHref}">The plain resume has everything</a></li>`);
  }
}

boot();
