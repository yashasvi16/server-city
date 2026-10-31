// The experience: loader -> fly-in -> scroll tour, with free explore,
// write-up sheet, live presence, guestbook lanterns and request flows.
import * as THREE from 'three';
import { site } from '../config/site.config';
import { Backend, type Mode, type Stats } from '../net/backend';
import { GuestbookClient } from '../net/guestbook';
import { LeaderboardClient, type ScoreRow } from '../net/leaderboard';
import { DECK } from '../world/layout';
import { GuestbookView } from '../ui/guestbook';
import { pickTier } from '../world/stage';
import { World } from '../world/world';
import { ABOUT_POSE, CameraRig, DEFENSE_POSE, framePose, gamePose, HERO_POSE, type Pose } from './camera';
import { esc, renderTour, writeupHTML } from './chapters';
import { Labels } from './labels';
import type { BootLog } from './loader';

export async function startExperience(log: BootLog, firstProbe: Promise<Stats | null>) {
  const tier = pickTier();
  const host = document.getElementById('stage')!;
  const tourEl = document.getElementById('tour')!;
  const sheet = document.getElementById('sheet')!;
  const live = document.getElementById('live')!;
  const presenceEl = document.getElementById('presence')!;
  const exploreBtn = document.getElementById('explore-toggle') as HTMLButtonElement;

  const t0 = performance.now();
  const world = await World.create(host, tier);
  const cam = world.stage.camera;
  log.done('load the baked city', `${world.landmarks.length} landmarks, ${Math.round(performance.now() - t0)} ms`);

  // ── chapters and camera keyframes ─────────────────────────────────────────
  const sections = renderTour(tourEl);
  const rig = new CameraRig(cam, world.stage.renderer.domElement);
  const poseFor = (key: string): Pose => {
    if (key === 'hero') return HERO_POSE();
    if (key === 'about') return ABOUT_POSE();
    if (key === 'defense') return DEFENSE_POSE();
    const l = world.byId.get(key);
    return l ? framePose(l.focus.target, l.focus.offset) : HERO_POSE();
  };
  const keys = sections.map((s) => s.dataset.landmark!);
  const recompute = () => rig.setTour(keys.map(poseFor));
  recompute();
  addEventListener('resize', recompute);

  // Scroll -> continuous chapter progress (0 = hero, 1 = first project, ...).
  let active = -1;
  const labels = new Labels(document.getElementById('labels')!, world.landmarks);
  // Rest point per chapter: centred on desktop; on phones the text card sits
  // at the bottom of its section, so rest where the card's bottom meets the
  // bottom of the screen and the island fills the space above.
  const centers = () => sections.map((s, i) =>
    innerWidth < 760 && i > 0 ? s.offsetTop + s.offsetHeight - innerHeight : s.offsetTop + s.offsetHeight / 2 - innerHeight / 2);
  let cs = centers();
  // Chapter heights change after load (guestbook form, flow steps, fonts),
  // so keep the scroll->chapter mapping in sync with the real layout.
  new ResizeObserver(() => {
    cs = centers();
    onScroll();
  }).observe(tourEl);
  addEventListener('resize', () => (cs = centers()));
  let introDone = false;
  const onScroll = () => {
    if (introDone) rig.interrupt(); // scrolling takes over from the fly-in
    const y = scrollY;
    let p = 0;
    for (let i = 0; i < cs.length - 1; i++) {
      if (y >= cs[i] && y <= cs[i + 1]) p = i + (y - cs[i]) / (cs[i + 1] - cs[i]);
      else if (y > cs[i + 1]) p = i + 1;
    }
    rig.setProgress(p);
    const idx = Math.round(p);
    if (idx !== active) {
      active = idx;
      const key = keys[idx];
      labels.focused = key;
      for (const l of world.landmarks) if (l.id !== key) l.stopFlow?.();
      document.documentElement.style.setProperty('--scrim', key === 'hero' ? '0.75' : '1');
      document.documentElement.dataset.chapter = key ?? '';
      if (key && key !== 'hero') history.replaceState(null, '', `#${key}`);
      else history.replaceState(null, '', location.pathname + location.search);
    }
  };
  addEventListener('scroll', onScroll, { passive: true });

  // ── chapter actions ───────────────────────────────────────────────────────
  let returnFocus: HTMLElement | null = null;
  const openSheet = (html: string) => {
    returnFocus = document.activeElement as HTMLElement;
    sheet.innerHTML = html;
    sheet.hidden = false;
    (sheet.querySelector('#sheet-title') as HTMLElement | null)?.focus({ preventScroll: true });
  };
  const closeSheet = () => {
    sheet.hidden = true;
    returnFocus?.focus?.({ preventScroll: true });
  };
  sheet.addEventListener('click', (e) => {
    if ((e.target as HTMLElement).closest('.close')) closeSheet();
  });
  addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !sheet.hidden) closeSheet();
  });

  tourEl.addEventListener('click', (e) => {
    const el = e.target as HTMLElement;
    const section = el.closest<HTMLElement>('section.chapter');
    const id = section?.dataset.landmark;
    const project = site.projects.find((p) => p.id === id);
    const btn = el.closest<HTMLButtonElement>('button');
    if (btn?.dataset.act === 'play') return void playDefense(btn);
    if (!btn || !section || !project) return;
    const act = btn.dataset.act;
    if (act === 'writeup') openSheet(writeupHTML(project));
    if (act === 'shot') world.pool?.strike();
    if (act === 'flows') {
      const picker = section.querySelector<HTMLElement>('.flow-picker')!;
      picker.hidden = !picker.hidden;
      btn.setAttribute('aria-expanded', String(!picker.hidden));
      if (!picker.hidden) (picker.querySelector('button') as HTMLButtonElement)?.click();
    }
    if (btn.dataset.flow !== undefined) playFlow(section, project.id, Number(btn.dataset.flow));
  });

  function playFlow(section: HTMLElement, id: string, i: number) {
    const p = site.projects.find((x) => x.id === id)!;
    const l = world.byId.get(id);
    const flow = p.flows?.[i];
    if (!l?.playFlow || !flow) return;
    section.querySelectorAll('[data-flow]').forEach((b) => b.setAttribute('aria-pressed', String(Number((b as HTMLElement).dataset.flow) === i)));
    const ol = section.querySelector('.steps')!;
    ol.innerHTML = flow.steps.map((s) => `<li><span><strong>${esc(p.nodes?.[s.node]?.label ?? s.node)}.</strong> ${esc(s.caption)}</span></li>`).join('');
    const items = [...ol.querySelectorAll('li')];
    l.playFlow(i, {
      onStep: (k) => {
        items.forEach((li, j) => {
          li.classList.toggle('active', j === k);
          li.classList.toggle('done', j < k);
        });
        live.textContent = items[k]?.textContent ?? '';
      },
      onDone: () => {
        items.forEach((li) => {
          li.classList.remove('active');
          li.classList.add('done');
        });
        section.querySelectorAll('[data-flow]').forEach((b) => b.setAttribute('aria-pressed', 'false'));
      },
    });
  }

  // ── explore mode ──────────────────────────────────────────────────────────
  const hint = document.createElement('p');
  hint.className = 'explore-hint';
  hint.hidden = true;
  hint.textContent = matchMedia('(pointer: coarse)').matches
    ? 'Drag to orbit, pinch to zoom, tap a building to read about it.'
    : 'Drag to orbit, scroll to zoom, right-drag to pan. Click a building to read about it.';
  document.getElementById('city-view')!.appendChild(hint);
  exploreBtn.hidden = false;
  let savedScroll = 0;
  exploreBtn.addEventListener('click', () => {
    if (rig.mode === 'tour') {
      savedScroll = scrollY;
      document.body.classList.add('explore');
      rig.enterExplore({ pos: cam.position.clone(), target: rig.target.clone() });
      labels.showTitles = true;
      labels.avoidText = false;
      labels.focused = null;
      exploreBtn.textContent = 'Back to the tour';
      hint.hidden = false;
    } else {
      document.body.classList.remove('explore');
      rig.leaveExplore();
      labels.showTitles = false;
      labels.avoidText = true;
      exploreBtn.textContent = 'Explore freely';
      hint.hidden = true;
      closeSheet();
      scrollTo(0, savedScroll);
      active = -1;
      onScroll();
    }
  });
  const ray = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  // The game deck is clickable in explore mode: it starts the game.
  const deckHit = new THREE.Mesh(new THREE.BoxGeometry(DECK.cols * DECK.cell + 12, 6, DECK.rows * DECK.cell + 6), new THREE.MeshBasicMaterial({ visible: false }));
  deckHit.position.set(DECK.x + 2, 3, DECK.z);
  deckHit.userData.landmark = 'defense';
  world.stage.scene.add(deckHit);
  const pick = (e: PointerEvent) => {
    ndc.set((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
    ray.setFromCamera(ndc, cam);
    // The pool table sits inside the pool hall's pick volume, so test it first.
    const table = world.pool ? ray.intersectObject(world.pool.table, false)[0] : undefined;
    return table ?? ray.intersectObjects([...world.hits, deckHit], false)[0];
  };
  let down: { x: number; y: number } | null = null;
  const canvas = world.stage.renderer.domElement;
  canvas.addEventListener('pointerdown', (e) => (down = { x: e.clientX, y: e.clientY }));
  canvas.addEventListener('pointerup', (e) => {
    if (rig.mode === 'game' || !down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 8) return;
    const hit = pick(e);
    if (!hit) return;
    // The pool table takes shots from the tour too, not only in explore mode.
    if (hit.object.userData.pool && world.pool) return world.pool.strikeAtWorld(hit.point);
    if (rig.mode !== 'explore') return;
    const id = hit.object.userData.landmark as string;
    if (id === 'defense') {
      exploreBtn.click();
      document.getElementById('defense')?.scrollIntoView();
      return void playDefense(document.querySelector<HTMLButtonElement>('#defense [data-act="play"]')!);
    }
    const l = world.byId.get(id);
    if (!l) return;
    const p = site.projects.find((x) => x.id === id);
    if (p) openSheet(writeupHTML(p));
    // Frame the building in the part of the screen the write-up leaves free.
    rig.focusLandmark(l, p && !sheet.hidden ? sheet.getBoundingClientRect().width / innerWidth : 0);
    labels.focused = id;
    if (!p && id === 'guestbook') scrollToGuestbook();
  });
  canvas.addEventListener('pointermove', (e) => {
    if (rig.mode !== 'explore' || e.buttons) return;
    const hit = pick(e);
    labels.hot = (hit?.object.userData.landmark as string) ?? null;
    canvas.style.cursor = hit ? 'pointer' : 'grab';
  });
  canvas.addEventListener('pointermove', (e) => {
    if (rig.mode !== 'tour' || e.buttons || !world.pool) return;
    ndc.set((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
    ray.setFromCamera(ndc, cam);
    canvas.style.cursor = ray.intersectObject(world.pool.table, false).length ? 'pointer' : '';
  });
  function scrollToGuestbook() {
    exploreBtn.click();
    document.getElementById('guestbook')?.scrollIntoView();
  }

  // ── tower-defense game (lazy-loaded) ──────────────────────────────────────
  const frameHooks = new Set<(dt: number, t: number) => void>();
  let gameOn = false;
  const onGameResize = () => gameOn && rig.setGamePose(gamePose(cam));
  addEventListener('resize', onGameResize);
  const lbClient = new LeaderboardClient(() => mode === 'live');
  const lbList = document.querySelector<HTMLOListElement>('#defense .lb-list')!;
  const lbMode = document.querySelector<HTMLElement>('#defense .lb-mode')!;
  const refreshBoard = async () => {
    lbMode.textContent = mode === 'live' ? 'live' : mode === 'demo' ? 'this browser only' : '';
    let rows: ScoreRow[];
    try {
      rows = await lbClient.top(10);
    } catch {
      lbList.innerHTML = '<li class="lb-empty">The leaderboard is unavailable right now.</li>';
      return;
    }
    lbList.innerHTML = rows.length
      ? rows.map((r, i) => `<li><span class="lb-rank">${i + 1}</span><span class="lb-name">${esc(r.name)}</span><span class="lb-score">${r.score.toLocaleString('en-US')}</span><span class="lb-wave">wave ${r.wave}</span></li>`).join('')
      : '<li class="lb-empty">No scores yet. Be the first.</li>';
  };
  async function playDefense(btn: HTMLButtonElement) {
    btn.disabled = true;
    const label = btn.textContent;
    btn.textContent = 'Loading…';
    try {
      const { openDefense } = await import('../game/defense');
      if (rig.mode === 'explore') exploreBtn.click();
      openDefense({
        lb: lbClient,
        host: {
          scene: world.stage.scene,
          camera: cam,
          dom: world.stage.renderer.domElement,
          enterGame: () => {
            gameOn = true;
            labels.focused = null;
            rig.enterGame(gamePose(cam));
          },
          leaveGame: () => {
            gameOn = false;
            rig.leaveGame();
            active = -1;
            onScroll(); // the tour eases the camera back to this chapter's view
          },
          onFrame: (cb) => {
            frameHooks.add(cb);
            return () => frameHooks.delete(cb);
          },
        },
        onScore: () => void refreshBoard(),
        onClose: () => void refreshBoard(),
      });
    } catch {
      live.textContent = 'The game failed to load. Check your connection and try again.';
    } finally {
      btn.disabled = false;
      btn.textContent = label;
    }
  }

  // ── backend: stats, presence, guestbook ───────────────────────────────────
  let mode: Mode = 'connecting';
  let stats: Stats | null = null;
  let waking = false;
  const redraw = () => world.hologram.draw(mode, stats, world.avatars.count, waking);
  const gbClient = new GuestbookClient(() => mode === 'live');
  const gb = new GuestbookView(gbClient, () => {
    if (mode !== 'live') world.garden.add();
  }, (n) => world.garden.seed(n));
  const setPresence = () => {
    presenceEl.hidden = false;
    presenceEl.classList.toggle('demo', mode !== 'live');
    const others = world.avatars.count;
    presenceEl.textContent = mode === 'live'
      ? others ? `${others} other ${others === 1 ? 'visitor' : 'visitors'} here` : 'Live, just you right now'
      : waking ? 'Waking the server…' : 'Demo mode';
  };
  const backend = new Backend({
    mode(m) {
      mode = m;
      redraw();
      setPresence();
      gb.mount(document.getElementById('gb-mount')!);
      void refreshBoard();
      log.done('GET /api/stats', m === 'live' ? '200, live' : 'offline, demo mode', m === 'live' ? 'ok' : 'warn');
    },
    stats(s) {
      stats = s;
      redraw();
    },
    upsert: (p) => {
      world.avatars.upsert(p);
      setPresence();
    },
    remove: (id) => {
      world.avatars.remove(id);
      setPresence();
    },
    self: (id) => world.avatars.setSelf(id),
    guestbook: (e) => {
      gb.prepend(e); // no-op if this tab posted it
      world.garden.add(); // every new message lights a lantern for everyone
    },
    waking: (on) => {
      waking = on;
      redraw();
      setPresence();
    },
    leaderboard: (board) => {
      if (board === 'defense') void refreshBoard();
    },
  });
  // Compile every shader now (in parallel where the GPU driver allows), so
  // the first seconds after the loader aren't a slideshow.
  const tc = performance.now();
  cam.position.copy(HERO_POSE().pos);
  cam.lookAt(HERO_POSE().target);
  await world.stage.renderer.compileAsync(world.stage.scene, cam);
  world.render(0.016, 0);
  log.done('compile shaders', `${Math.round(performance.now() - tc)} ms`);
  cam.position.set(240, 170, 420);
  cam.lookAt(0, 20, 0);
  await backend.start(firstProbe);

  // ── loop ──────────────────────────────────────────────────────────────────
  const timer = new THREE.Timer();
  timer.connect(document); // pauses cleanly when the tab is hidden
  let frames = 0, acc = 0, downgraded = false;
  const perf = { fps: 0 };
  (window as unknown as { __city: unknown }).__city = { perf, tier, world, rig };
  let firstFrame = true;
  world.stage.renderer.setAnimationLoop(() => {
    timer.update();
    const dt = Math.min(timer.getDelta(), 0.1);
    const t = timer.getElapsed();
    rig.update(dt, t);
    for (const h of frameHooks) h(dt, t);
    // Blur band only for wide shots of the island; none when zoomed in on a place or playing.
    const dist = cam.position.distanceTo(rig.target);
    world.stage.setTiltShift(gameOn ? 0 : THREE.MathUtils.smoothstep(dist, 105, 135));
    world.update(dt, t);
    labels.update(cam);
    backend.sendPosition(rig.target.x, rig.target.z);
    world.render(dt, t);
    if (firstFrame) {
      firstFrame = false;
      log.done('first frame', `${Math.round(performance.now() - t0)} ms`);
      log.finish(() => {
        // Fly in from above the clouds, then hand the camera to the scroll.
        const hash = location.hash.slice(1);
        const start = keys.indexOf(hash);
        if (start > 0) sections[start].scrollIntoView();
        onScroll();
        rig.fly(start > 0 ? poseFor(hash) : HERO_POSE(), 3.4, () => onScroll());
        introDone = true;
      });
    }
    frames++;
    acc += dt;
    if (acc >= 2) {
      perf.fps = frames / acc;
      if (!downgraded && perf.fps < 28 && world.stage.renderer.getPixelRatio() > 1) {
        world.stage.setPixelRatio(1);
        downgraded = true;
      }
      frames = 0;
      acc = 0;
    }
  });
}
