// Rules tests for Traffic Defense. Run: npm test
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CACHE, ERROR_BUDGET, LEVELS, MAX_WAVE, PADS, road, Sim, TOWERS, WAVE_SCORE_CAP, waveSchedule, mulberry32, upgradeCost,
} from './sim';

// Mirrors BoardRules{"defense"} in backend/internal/api/community.go.
const SERVER = { maxWave: 50, maxScorePerWave: 2000, minMsPerWave: 4000 };

function runWave(s: Sim, maxSec = 120) {
  assert.ok(s.startWave());
  for (let t = 0; t < maxSec && s.state === 'wave'; t += 1 / 30) s.step(1 / 30);
}

/** Fill every pad with a mix of towers, fully upgraded. */
function fortify(s: Sim) {
  const kinds = ['limiter', 'cache', 'lb'] as const;
  PADS.forEach(([c, r], i) => s.place(kinds[i % 3], c, r));
  for (const t of s.towers) while (s.upgrade(t.id) === null);
}

test('towers go only on free pads, and only with enough credits', () => {
  const s = new Sim(1);
  const [c, r] = [...road.cells][0].split(',').map(Number);
  const [pc, pr] = PADS[0];
  assert.equal(s.canPlace('cache', c, r), 'That’s the road.');
  assert.equal(s.canPlace('cache', -1, 0), 'Off the map.');
  assert.equal(s.canPlace('cache', 0, 8), 'Build on the marked pads.');
  assert.equal(typeof s.place('cache', pc, pr), 'object');
  assert.equal(s.canPlace('limiter', pc, pr), 'Something is already there.');
  s.credits = 10;
  assert.match(s.canPlace('lb', PADS[1][0], PADS[1][1])!, /Needs 60 credits/);
});

test('upgrades cost more each level, cap at 3, and sell refunds 60% of everything spent', () => {
  const s = new Sim(1);
  s.credits = 1000;
  const t = s.place('lb', PADS[0][0], PADS[0][1]);
  assert.ok(typeof t === 'object');
  assert.equal(upgradeCost(t), 120);
  assert.equal(s.upgrade(t.id), null);
  assert.equal(t.server!.workers.length, LEVELS.lb.workers[1]);
  assert.equal(s.upgrade(t.id), null);
  assert.equal(s.upgrade(t.id), 'Fully upgraded.');
  assert.equal(t.spent, 60 + 120 + 240);
  const before = s.credits;
  assert.equal(s.sell(t.id), Math.floor(420 * 0.6));
  assert.equal(s.credits, before + 252);
  assert.equal(s.canPlace('cache', PADS[0][0], PADS[0][1]), null);
});

test('the cloud bill is charged when a wave starts', () => {
  const s = new Sim(1);
  s.credits = 200;
  s.place('limiter', PADS[0][0], PADS[0][1]);
  s.place('cache', PADS[1][0], PADS[1][1]);
  const before = s.credits;
  assert.equal(s.bill, TOWERS.limiter.upkeep + TOWERS.cache.upkeep);
  s.startWave();
  assert.equal(s.credits, before - s.bill);
  assert.equal(200 - TOWERS.limiter.cost - TOWERS.cache.cost - s.bill, s.credits);
});

test('wave 1 with no defences is survivable and pays out', () => {
  const s = new Sim(7);
  runWave(s);
  assert.equal(s.state, 'build');
  assert.equal(s.wave, 1);
  assert.ok(s.score > 0);
  assert.ok(s.budget > 0);
});

test('the rate limiter drops bots only, and never more than its tokens allow', () => {
  const s = new Sim(3);
  const lim = s.place('limiter', 4, 1); // beside the first stretch of road
  assert.ok(typeof lim === 'object');
  s.wave = 3; // a wave with bursts and heavy writes
  let drops = 0;
  assert.ok(s.startWave());
  for (let t = 0; t < 120 && s.state === 'wave'; t += 1 / 30) {
    s.step(1 / 30);
    for (const e of s.events) if (e.t === 'drop') drops++;
    s.events.length = 0;
    assert.ok(lim.tokens >= 0 && lim.tokens <= LEVELS.limiter.capacity[0]);
  }
  const bursts = waveSchedule(4, mulberry32(3)).filter((x) => x.kind === 'burst').length;
  assert.ok(drops > 0, 'limiter should drop some bot traffic');
  assert.ok(drops <= bursts, 'limiter must not drop more than the bots that exist');
  // token bucket bound: capacity plus refill over the elapsed time
  assert.ok(drops <= LEVELS.limiter.capacity[0] + LEVELS.limiter.refill[0] * s.time + 1);
});

test('cache hit ratio warms up from its minimum toward its maximum', () => {
  const s = new Sim(5);
  const c = s.place('cache', 2, 3); // inside the first bend
  assert.ok(typeof c === 'object');
  for (let i = 0; i < 4; i++) runWave(s);
  assert.ok(c.looks > 20);
  assert.ok(c.warm > 0.9);
  const ratio = c.hits / c.looks;
  assert.ok(ratio > CACHE.minHit * 0.5 && ratio < CACHE.maxHit + 0.15, `hit ratio ${ratio}`);
});

test('undefended late waves overflow the origin queue and end the run', () => {
  const s = new Sim(2);
  for (let i = 0; i < 15 && s.state !== 'over'; i++) runWave(s);
  assert.equal(s.state, 'over');
  assert.equal(s.budget, 0);
  assert.ok(s.errors >= ERROR_BUDGET / 2);
  assert.equal(s.canPlace('cache', 0, 0), 'The run is over.');
});

test('every reachable score passes the server plausibility check', () => {
  // A strong build played for many waves: score per wave never exceeds the cap,
  // so score <= wave * 2000 always holds, and waves can't finish in under 4 s.
  const s = new Sim(11);
  s.credits = 100000;
  fortify(s);
  let last = 0;
  for (let i = 0; i < 12; i++) {
    const t0 = s.time;
    runWave(s, 300);
    assert.notEqual(s.state, 'over');
    assert.ok(s.score - last <= WAVE_SCORE_CAP);
    last = s.score;
    assert.ok((s.time - t0) * 1000 >= SERVER.minMsPerWave, `wave ${s.wave} took ${s.time - t0}s`);
  }
  assert.ok(s.score <= s.wave * SERVER.maxScorePerWave);
  assert.ok(MAX_WAVE <= SERVER.maxWave);
});

test('waves get harder: more requests, bots from wave 2, heavy writes from wave 3', () => {
  const r = mulberry32(1);
  const w1 = waveSchedule(1, r), w2 = waveSchedule(2, r), w3 = waveSchedule(3, r), w10 = waveSchedule(10, r);
  assert.equal(w1.filter((x) => x.kind !== 'get').length, 0);
  assert.ok(w2.some((x) => x.kind === 'burst'));
  assert.ok(!w2.some((x) => x.kind === 'heavy'));
  assert.ok(w3.some((x) => x.kind === 'heavy'));
  assert.ok(w10.length > w3.length);
});
