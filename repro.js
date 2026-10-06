'use strict';
// Minimal repro: V8 memory reducer never fires after an allocation burst on
// Node 24/26 (V8 13.x/14.x), because the embedder (cppgc) allocation rate is
// always 0 in Node, which ComputeMutatorUtilization reads as "high alloc".
//
// Usage:
//   node --trace-gc --trace-memory-reducer --trace-mutator-utilization repro.js [idle-mode]
//
// idle-mode:
//   log      (default) after the burst, only log process.memoryUsage() every 2 s
//   trickle  same, plus allocate ~64 KB of short-lived objects every 100 ms
//   silent   after the burst, allocate nothing at all (no JS logging; one timer)
//
// Expected:
//   Node 22: "Memory reducer: ... low alloc" and a "Mark-Compact (reduce)" GC
//            within ~10-20 s of idle; heapUsed/RSS drop.
//   Node 24/26: "high alloc, foreground" on every tick and no GC until the
//            memory reducer watchdog fires ~100 s after the last GC.

const BURST_MS = 5000;
const IDLE_MS = 150000;
const LOG_EVERY_MS = 2000;
const RETAIN_CHUNKS = 48; // live sliding window during the burst (~100+ MB)
const mode = process.argv[2] || 'log';

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
    // No JS allocation at all during idle; rely on --trace-gc output.
    setTimeout(() => log('end'), IDLE_MS);
    return;
  }
  let sink = null;
  if (mode === 'trickle') {
    setInterval(() => {
      const a = new Array(1000);
      for (let k = 0; k < a.length; k++) a[k] = { k };
      sink = a; // short-lived
    }, 100).unref();
  }
  const iv = setInterval(() => {
    log('idle');
    if (Date.now() - idleStart >= IDLE_MS) { clearInterval(iv); log('end'); process.exit(0); }
  }, LOG_EVERY_MS);
}

burst();
