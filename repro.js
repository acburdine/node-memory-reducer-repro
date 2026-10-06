'use strict';
// Minimal repro: on Node 24/26 (V8 13.x/14.x) the memory reducer cannot start
// through its low-allocation condition after an allocation burst when the
// sampled embedder (cppgc) allocation throughput is exactly 0, which
// ComputeMutatorUtilization reads as "high alloc". The baseline workload here
// does not intentionally create cppgc-backed objects.
//
// Usage:
//   node --trace-gc --trace-memory-reducer --trace-mutator-utilization repro.js [idle-mode]
//
// idle-mode:
//   log      (default) after the burst, only log process.memoryUsage() every 2 s
//   trickle  same, plus allocate ~64 KB of short-lived objects every 100 ms
//   silent   after the burst, no recurring application callbacks (one timer, no JS logging)
//   vm-once      like `log`, but compile one `vm.Script` at startup (a single cppgc allocation)
//   vm-periodic  like `log`, plus compile a `vm.Script` every 30 s during idle
//   vm-once-reburst      `vm-once`, then a second 5 s burst at ~130 s and ~80 s more observation
//   vm-periodic-reburst  `vm-periodic`, then the same second burst
//
// Observed (see README):
//   Node 22: "Memory reducer: ... low alloc" and a "Mark-Compact (reduce)" GC
//            ~40 s after the burst; heapUsed/RSS drop.
//   Node 24/26: "high alloc, foreground" on every tick; the reduce GC waits for
//            the watchdog (~100 s after the last major GC). Ordinary GCs can
//            still occur and push the watchdog out further.

const BURST_MS = 5000;
const IDLE_MS = 150000;
const LOG_EVERY_MS = 2000;
const RETAIN_CHUNKS = 48; // live sliding window during the burst (~100+ MB)
const mode = process.argv[2] || 'log';
const vm = require('node:vm');
// node:vm scripts/contexts are a Node core path that allocates on the cppgc heap
// (src/node_contextify.cc), which is what the embedder allocation throughput measures.
if (mode.startsWith('vm-')) new vm.Script('1');

const t0 = Date.now();
const mb = (n) => (n / 1048576).toFixed(1);

function log(tag) {
  const m = process.memoryUsage();
  console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${tag} rss=${mb(m.rss)}MB heapTotal=${mb(m.heapTotal)}MB heapUsed=${mb(m.heapUsed)}MB`);
}

function makeChunk(i) {
  // ~2.5 MB of objects + strings
  const arr = new Array(20000);
  for (let j = 0; j < arr.length; j++) {
    arr[j] = { id: i * 100000 + j, name: 'item-' + i + '-' + j, tags: [j, j + 1, 'x' + j], payload: 'p'.repeat(32) + j };
  }
  return arr;
}

log(`start node=${process.version} v8=${process.versions.v8} mode=${mode}`);

let window = [];
let i = 0;
const burstEnd = Date.now() + BURST_MS;
function burst() {
  // Run in slices so timers/GC tasks can interleave, like a server under load.
  const sliceEnd = Date.now() + 50;
  while (Date.now() < sliceEnd) {
    window.push(makeChunk(i++));
    if (window.length > RETAIN_CHUNKS) window.shift();
  }
  if (Date.now() < burstEnd) return setImmediate(burst);
  log(`burst done chunks=${i}`);
  window = null; // everything is now garbage
  idle();
}

function idle() {
  const idleStart = Date.now();
  if (mode === 'silent') {
    // No recurring application callbacks during idle; rely on --trace-gc output.
    setTimeout(() => log('end'), IDLE_MS);
    return;
  }
  let sink = null;
  if (mode.startsWith('vm-periodic')) {
    setInterval(() => new vm.Script('1'), 30000).unref();
  }
  if (mode.endsWith('-reburst')) {
    setTimeout(() => { log('reburst'); window = []; i = 0; burstAgain(); }, 125000).unref();
  }
  if (mode === 'trickle') {
    setInterval(() => {
      const a = new Array(1000);
      for (let k = 0; k < a.length; k++) a[k] = { k };
      sink = a; // short-lived
    }, 100).unref();
  }
  const total = mode.endsWith('-reburst') ? IDLE_MS + 60000 : IDLE_MS;
  const iv = setInterval(() => {
    log('idle');
    if (Date.now() - idleStart >= total) { clearInterval(iv); log('end'); process.exit(0); }
  }, LOG_EVERY_MS);
}

function burstAgain() {
  const end = Date.now() + BURST_MS;
  (function slice() {
    const sliceEnd = Date.now() + 50;
    while (Date.now() < sliceEnd) {
      window.push(makeChunk(i++));
      if (window.length > RETAIN_CHUNKS) window.shift();
    }
    if (Date.now() < end) return setImmediate(slice);
    log(`reburst done chunks=${i}`);
    window = null;
  })();
}

burst();
