'use strict';
// node --trace-gc --trace-memory-reducer --trace-mutator-utilization repro-min.js
// 5 s allocation burst, drop everything, idle 150 s logging process.memoryUsage() every 2 s.
const t0 = Date.now();
const mb = (n) => (n / 1048576).toFixed(1);
function log(tag) {
  const m = process.memoryUsage();
  console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${tag} rss=${mb(m.rss)}MB heapTotal=${mb(m.heapTotal)}MB heapUsed=${mb(m.heapUsed)}MB`);
}
function makeChunk(i) { // ~2.5 MB of objects and strings
  const arr = new Array(20000);
  for (let j = 0; j < arr.length; j++) {
    arr[j] = { id: i * 100000 + j, name: 'item-' + i + '-' + j, tags: [j, j + 1, 'x' + j], payload: 'p'.repeat(32) + j };
  }
  return arr;
}
log(`start node=${process.version} v8=${process.versions.v8}`);
let window = [], i = 0;
const burstEnd = Date.now() + 5000;
(function burst() { // sliding window of ~48 live chunks; run in 50 ms slices so GC tasks can interleave
  const sliceEnd = Date.now() + 50;
  while (Date.now() < sliceEnd) { window.push(makeChunk(i++)); if (window.length > 48) window.shift(); }
  if (Date.now() < burstEnd) return setImmediate(burst);
  log(`burst done chunks=${i}`);
  window = null; // everything is now garbage
  const idleStart = Date.now();
  const iv = setInterval(() => {
    log('idle');
    if (Date.now() - idleStart >= 150000) { clearInterval(iv); log('end'); process.exit(0); }
  }, 2000);
})();
