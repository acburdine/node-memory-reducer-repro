# Node 24/26: V8 MemoryReducer never sees "low allocation" when cppgc allocation throughput is 0

Minimal, dependency-free reproduction of a V8 GC-heuristic regression that reaches Node.js 24 and 26.

**TL;DR.** After an allocation burst followed by idle, Node 22 (V8 12.4) runs a memory-reducing GC
within tens of seconds and returns memory to the OS. Node 24 (V8 13.6) and 26 (V8 14.6) report
`Memory reducer: high alloc` on every tick and only collect when the reducer's 100 s watchdog fires —
or never, if something else triggers an ordinary major GC first. Cause: since V8 CL
[5935313](https://chromium-review.googlesource.com/c/v8/v8/+/5935313) the embedder (cppgc) allocation
throughput has no lower bound, so a process that never allocates on cppgc (any plain-JS Node workload)
reports exactly `0`, which `Heap::ComputeMutatorUtilizationImpl()` treats as *maximal* allocation.
A 3-line patch to `Heap::HasLowEmbedderAllocationRate()` fixes it (verified with a patched build).

```
node --trace-gc --trace-memory-reducer --trace-mutator-utilization repro.js [log|trickle|silent|vm-once|vm-periodic|vm-once-reburst]
./run.sh 24.21.0 log        # same, inside node:24.21.0-bookworm-slim, output in traces/
```

| first `Mark-Compact (reduce)` after the burst | 22.23.3 | 24.21.0 | 26.10.0 | 24.21.0 + patch |
|---|---|---|---|---|
| idle: 2 s logging timer | 44 s | 100 s (watchdog) | 97 s (watchdog) | **11 s** (control build: 100 s) |
| idle: + 64 KB garbage / 100 ms | 36 s | **never in 150 s, RSS 700 MB** | 122 s (watchdog) | 11 s (control: 140 s) |
| idle: one 150 s timer | 44 s | 100 s (watchdog) | 98 s (watchdog) | 11 s (control: 100 s) |

Investigation date: 2026-10-06. Upstream reports: V8 <TBD>, nodejs/node <TBD>.

## Layout

| Path | What |
|---|---|
| `repro.js` | Standalone repro (no deps) |
| `run.sh` | `./run.sh <node-version> <idle-mode> [extra node flags]` → runs in `node:<v>-bookworm-slim` (or `IMAGE=…`), writes `traces/…log` with host-elapsed-seconds prefix |
| `traces/` | Raw outputs: 3 Node versions × 3 idle modes, flag experiments, patched and control from-source Node 24 builds |
| `patch/` | Proposed fix (`0001-…patch`, paths are `deps/v8/…`; use `src/heap/heap.cc` for upstream) + `Dockerfile` that builds Node 24.21.0 with (`APPLY_PATCH=1`) or without (`APPLY_PATCH=0`) it |

Source references below are to `deps/v8/src/heap/` at the nodejs/node tags
[v22.23.3](https://github.com/nodejs/node/tree/v22.23.3/deps/v8/src/heap),
[v24.21.0](https://github.com/nodejs/node/tree/v24.21.0/deps/v8/src/heap),
[v26.10.0](https://github.com/nodejs/node/tree/v26.10.0/deps/v8/src/heap); `src/v24.21.0/heap.cc:3669`
means `deps/v8/src/heap/heap.cc` line 3669 at tag v24.21.0.

## Mechanism

Every 8 s (`kLongDelayMs`) while in `kWait`, `MemoryReducer::TimerTask::RunInternal`
(`src/v24.21.0/memory-reducer.cc:46-50`) calls `tracer()->SampleAllocation(...)` and then
`heap->HasLowAllocationRate()`:

```cpp
// src/v24.21.0/heap.cc:3669-3728
double ComputeMutatorUtilizationImpl(double mutator_speed, std::optional<double> gc_speed) {
  constexpr double kMinMutatorUtilization = 0.0;
  constexpr double kConservativeGcSpeedInBytesPerMillisecond = 200000;
  if (mutator_speed == 0) return kMinMutatorUtilization;        // checked before gc_speed fallback
  if (!gc_speed) gc_speed = kConservativeGcSpeedInBytesPerMillisecond;
  return *gc_speed / (mutator_speed + *gc_speed);
}
bool Heap::HasLowEmbedderAllocationRate() {
  double mu = ComputeMutatorUtilization(
      "Embedder", tracer()->EmbedderAllocationThroughputInBytesPerMillisecond(),
      tracer()->EmbedderSpeedInBytesPerMillisecond());
  return mu > 0.993;
}
bool Heap::HasLowAllocationRate() {
  return HasLowYoungGenerationAllocationRate() &&
         HasLowOldGenerationAllocationRate() && HasLowEmbedderAllocationRate();   // && short-circuits
}
```

The timer starts a GC when `low_allocation_rate || ShouldOptimizeForMemoryUsage()` or when the
watchdog fires (`memory-reducer.cc:61-69, 188-207`), subject to incremental marking being startable
and the GC-count limit.

**V8 12.4 (Node 22):** `HasLowEmbedderAllocationRate` reads
`CurrentEmbedderAllocationThroughputInBytesPerMillisecond()` (`src/v22.23.3/heap.cc:3739-3743`), the
5 s-window variant of `BoundedAverageSpeed` over a `RingBuffer<BytesAndDuration>`
(`gc-tracer.cc:54-66, 1304-1307`). `heap::base::AverageSpeed` (`base_bytes.h:49-58`) returns
`max(min(bytes/duration, max), kMinNonEmptySpeedInBytesPerMs = 1)` whenever accumulated duration is
non-zero — so a buffer of zero-byte samples yields **1 B/ms**, not 0. `EmbedderSpeedInBytesPerMillisecond()`
is 0 (no embedder GC recorded) and is replaced by the 200000 B/ms conservative constant, giving
`mu = 200000/(1+200000) ≈ 0.999995 > 0.993`. Trace:
`Embedder mutator utilization = 1.000 (mutator_speed=1, gc_speed=0)`.

**V8 13.6 / 14.6 (Node 24 / 26):** allocation throughput is a `heap::base::SmoothedBytesAndDuration`
(`src/v24.21.0/base_bytes.h`), read through `BoundedThroughput()` = `min(GetThroughput(), 1 GB/ms)`
(`gc-tracer.cc:64-67, 1393-1394`) — **no lower bound**. `throughput_` starts at `0.0`; `Update()` with a
zero-byte sample computes `0 + Decay(0 - 0) = 0`, so a tracker that has only ever seen zero-byte samples
is exactly `0.0`. `ComputeMutatorUtilizationImpl` returns `0.0` for `mutator_speed == 0` before it looks at
`gc_speed`, so `HasLowEmbedderAllocationRate()` is false, `HasLowAllocationRate()` is false, and the
reducer logs `high alloc, foreground` on every tick. Trace:
`Embedder mutator utilization = 0.000 (mutator_speed=0, gc_speed=1)`.

Note `gc_speed=1` here: `EmbedderSpeedInBytesPerMillisecond()` in 13.6 is `BoundedAverageSpeed(recorded_embedder_marking_)`
which *does* still floor at 1. So simply restoring a 1 B/ms floor on the allocation side would give
`mu = 1/(1+1) = 0.5` and **would not fix it**. (Earlier draft of this README listed that as an alternative
fix; it is wrong.)

The `mutator_speed == 0 → 0.0` early return itself is old (already in 12.4). What changed is that the
value fed to it can now be exactly 0.

### Scope: when is cppgc throughput exactly 0? (and the `vm.Script` workaround)

`Heap::EmbedderAllocationCounter()` only counts allocations on the isolate's `CppHeap`. Node core does
allocate there in one place: `src/node_contextify.cc:324, 975` (v24.21.0) create `ContextifyContext` /
`ContextifyScript` with `cppgc::MakeGarbageCollected`, i.e. the `node:vm` module. Native addons can too
(`test/addons/cppgc-object/binding.cc`). A plain-JS workload that never touches `vm` has a tracker that
has never seen a non-zero sample.

Measured on the official `node:24.21.0` image (`traces/24.21.0-vm-*.log`):

| mode | what | result |
|---|---|---|
| `vm-once` | one `new vm.Script('1')` at startup, then burst + idle | `low alloc` on 2nd tick, reduce GC **11 s** after burst — same as the patched build |
| `vm-periodic` | same, plus a `vm.Script` every 30 s during idle | 11 s |
| `vm-once-reburst` | `vm-once`, then a second burst at ~130 s | first burst: 11 s. **Second burst: `high alloc` on every tick to the end of the run (80 s later)**, `Embedder mutator utilization = 0.000 (mutator_speed=0, gc_speed=1)` again |

So any positive cppgc throughput, however small, passes the 0.993 test (`gc_speed/(tiny + gc_speed)`),
and a single `vm.Script` compile is enough to unstick the reducer — **for about 110 s**. The tracker
decays by `exp2(-elapsed/100 ms)`; after ~1100 half-lives the double underflows to exactly `0.0` and the
`mutator_speed == 0` early return is back. In `vm-once-reburst` the one-shot allocation is ~130 s old
when the second burst ends, and the trace shows exactly that. (This also demonstrates the
"exact-zero after long idle" behaviour of `SmoothedBytesAndDuration` empirically; see Unverified notes
for why it probably doesn't bite the young/old terms.)

Practical consequence: a userland stopgap exists — compile a trivial `vm.Script` on an interval shorter
than ~100 s (or per request). Ugly, but it is the only JS-reachable lever found that fixes the heuristic
without changing heap sizing. First noticed independently in Ghost by allocating a `vm.Script`.

### Other ways the reducer can start (none apply to the repro)

- `ShouldOptimizeForMemoryUsage()` (`src/v24.21.0/heap.cc:3781-3786`): isolate priority
  `kBestEffort`, `MemorySaverModeEnabled()` (true under `--optimize-for-size` or `--memory-saver-mode`,
  `src/execution/isolate.h:2124`), `HighMemoryPressure()`, or `!CanExpandOldGeneration(max/8)`.
- The watchdog: `WatchdogGC` fires when `time > last_gc_time_ms + 100000`. `last_gc_time_ms` is set by
  the `kMarkCompact` event (`memory-reducer.cc:205-207`), which only `MARK_COMPACTOR` sends
  (`heap.cc:1696`). Scavenges do not reset it; any major GC does.
- `NotifyPossibleGarbage()` (context disposal, first old-gen expansion with
  `memory_reducer_for_small_heaps`, background activation) only moves the reducer into `kWait`; the
  timer still has to pass the allocation test or the watchdog.
- `MemoryPressureNotification` can run reducing GCs independently of the reducer (`heap.cc:4166-4208`).

### The CL

- **"[gc] Use exponential decay for allocation speed"** — v8/v8 `790224716ed77349642301acd19f01442b82e857`,
  2024-10-30, Etienne Pierre-doray. https://chromium-review.googlesource.com/c/v8/v8/+/5935313.
  `Bug: 42203776` ("Improve GC scheduling heuristics", umbrella). First shipped in V8 13.1; first Node
  major with it is 24.
- Replaces `BoundedAverageSpeed` (floor 1 B/ms) with `BoundedThroughput` (no floor) for the three
  allocation trackers. The only review exchange near this (gc-tracer.cc) is Lippautz asking about the
  old default constants and the author replying the old code "would also previously return 0 for an
  empty buffer". No comment in the review discusses zero-byte samples or `HasLowAllocationRate`; that is
  all that can be said about intent.
- Related: https://issues.chromium.org/issues/42204538 "Allocation rate remains high even when thread is
  idle for several seconds" (P2, New, 2024-01) describes the ring-buffer behaviour the CL replaced
  (10 samples × 8 s ticks → ~40 s before "low alloc"). The CL does not reference it; treat as context.
- Later commits touching this code, none of which change the zero case: `c4820ea8` (optional gc speed,
  CL 6063402), `154458d4` (1 s decline decay, CL 7493262, not in 14.6), `758abf22` (external-memory
  tracker, CL 7823679). `ComputeMutatorUtilizationImpl`, `HasLowEmbedderAllocationRate` and
  `BoundedThroughput` on v8/v8 `main` (fetched 2026-10-06) are unchanged in the relevant lines.

## Repro results (Docker, linux/arm64, `--cpus=2`, one run each)

`repro.js`: 5 s allocation burst (sliding window of ~48 × 2.5 MB chunks of objects/strings; 600–900 MB
heap), drop everything, idle 150 s logging `process.memoryUsage()` every 2 s.

Idle modes: `log` (only the 2 s logging timer), `trickle` (+ ~64 KB short-lived garbage every 100 ms),
`silent` (one 150 s timer, no recurring JS callbacks).

| Run | first `Mark-Compact (reduce)` after burst end | heapUsed before→after | RSS at 155 s |
|---|---|---|---|
| 22.23.3 log | **44 s** (`low alloc` at t=49.4) | 396 → 3.6 MB | 19 MB |
| 22.23.3 silent | 44 s | 718 → 3.9 MB | 24 MB |
| 22.23.3 trickle | 36 s | 521 → 3.6 MB | 31 MB |
| 24.21.0 log | **100 s** (watchdog; `high alloc` every tick) | 682 → 4.3 MB | 45 MB |
| 24.21.0 silent | 100 s (watchdog) | 739 → 4.2 MB | 42 MB |
| 24.21.0 trickle | **none within 150 s** | — | **700 MB** |
| 26.10.0 log | 97 s (watchdog) | 633 → 4.2 MB | 36 MB |
| 26.10.0 silent | 98 s (watchdog) | 719 → 4.1 MB | 38 MB |
| 26.10.0 trickle | 122 s (watchdog) | (already collected by a regular MC at 25 s) | 39 MB |

Notes:
- **Node 22's 44 s** is the old-generation term, not the embedder: `Old generation mutator utilization`
  is 0.976 at 25.1 s, 0.986, 0.990, then 0.994 (> 0.993) at 49.4 s (`traces/22.23.3-log.log`). The young
  term crosses at 25.1 s. Because of `&&` short-circuiting the embedder term is only evaluated (and
  printed) on ticks where young and old already pass — twice in that trace, both `1.000`. This slow
  decay is what crbug 42204538 complains about. In the Ghost observation the reduce GC came ~10 s after
  load ended (lighter burst); that observation is not in this folder.
- On 24/26 young and old pass from the second tick on; the embedder term is `0.000` on every evaluated
  tick (`traces/24.21.0-log.log:58-62`).
- **`trickle` on 24**: a regular (non-reduce) `Mark-Compact` at 96.8 s ("finalize incremental marking via
  task"; what started marking is not in the trace — needs `--trace-incremental-marking`) resets
  `last_gc_time_ms`, so the watchdog cannot fire before ~197 s. It reports `pooled: 746 MB` and RSS stays
  ~700 MB to the end of the 150 s run. A reduce GC releases pooled pages (`heap.cc:1139-1141`); a
  regular one keeps them. The run does not show what happens after 197 s.
- **`trickle` on 26**: regular MC at 25.5 s (`pooled: 650.8 MB`), RSS stays 699 MB until ~95 s, then
  drops to 96 MB with no GC logged at that time (`traces/26.10.0-trickle.log`). Not investigated
  (possibly delayed pool release); watchdog reduce GC at 127 s finds 4 MB live.

Decisive trace lines (verbatim from `traces/24.21.0-log.log:58-62` and `traces/22.23.3-log.log`):

```
# Node 24.21.0 (V8 13.6.233.17) — every 8 s tick during idle
16282 ms: Young generation mutator utilization = 1.000 (mutator_speed=1, gc_speed=18662)
16283 ms: Old generation mutator utilization = 1.000 (mutator_speed=2, gc_speed=905860)
16283 ms: Embedder mutator utilization = 0.000 (mutator_speed=0, gc_speed=1)
16283 ms: Memory reducer: high alloc, foreground
16283 ms: Memory reducer: waiting for 8000 ms
...
105424 ms: Memory reducer: started GC #1          <- watchdog, 100 s after the last major GC (t=1.09 s)
105559 ms: Mark-Compact (reduce) 681.6 (777.1) -> 4.3 (20.6) MB

# Node 22.23.3 (V8 12.4.254.21)
49444 ms: Old generation mutator utilization = 0.994 (mutator_speed=1220, gc_speed=187518)
49444 ms: Embedder mutator utilization = 1.000 (mutator_speed=1, gc_speed=0)
49444 ms: Memory reducer: low alloc, foreground
49444 ms: Memory reducer: started GC #1
49529 ms: Mark-Compact (reduce) 396.4 (426.6) -> 3.6 (10.4) MB
```

## Flag experiments (idle mode `log`, one run each)

| Flag | 24.21.0 | 26.10.0 | Why |
|---|---|---|---|
| `--no-memory-reducer-for-small-heaps` | no change (watchdog at 105 s) | — | only gates one `NotifyPossibleGarbage()` source |
| `--memory-reducer-gc-count=1` | no change (105 s) | — | caps GCs per cycle, not the start decision |
| `--gc-memory-reducer-start-delay-ms=1000` | no change (107 s) | no change (107 s) | shortens the initial wait; ticks still `high alloc` |
| `--memory-reducer-delay-ms=1000` (26 only) | — | no change (102 s) | tick every 1 s instead of 8 s; still `high alloc` |
| `--optimize-for-size` | reducer GC 8 s after burst; RSS 29 MB | 25 s after burst; RSS 30 MB | `Isolate::MemorySaverModeEnabled()` returns true under this flag → `ShouldOptimizeForMemoryUsage()` true → reducer runs as `background`. Side effects: semi-space capped at 1 MB and `GCFlagsForIncrementalMarking` turns ordinary incremental GCs into reduce GCs — 19 `(reduce)` MCs during the 5 s burst (not reducer-started; the 2 reducer GCs come after), burst got through 49 chunks vs 106. Cost is workload-dependent; heavy for this one. |
| `--memory-saver-mode` | reducer GC 8 s after burst (`background`); RSS 32 MB | — | same `MemorySaverModeEnabled()` path. Still makes ordinary incremental GCs reduce GCs (18 `(reduce)` MCs during the burst) but no semi-space cap: burst got through 111 chunks vs 106 baseline, heapTotal peaked ~405 MB vs ~777 MB. **Closest thing to a usable workaround found**; one run, needs a real-workload cost check. |

No `--memory-reducer*` / `--gc-memory-reducer*` flag reaches `HasLowAllocationRate()`. From the
embedder (C++) side, `Isolate::SetPriority(kBestEffort)` or `MemorySaverModeEnabled()` would also make
the reducer run; neither is exposed to JS by Node.

## Patched build

`patch/0001-heap-treat-zero-embedder-allocation-rate-as-low.patch` adds, at the top of
`Heap::HasLowEmbedderAllocationRate()`:

```cpp
if (embedder_allocation_rate == 0) return true;
```

Exact zero is deliberate: any positive throughput still goes through the existing
`gc_speed/(rate + gc_speed)` comparison, so an embedder that does allocate on cppgc is unaffected. The
tracker cannot distinguish "never measured" from "measured zero"; both mean no cppgc allocation has
been seen, which is a low allocation rate. Dry-run applies to v24.21.0 and to v8/v8 `main`
(path `src/heap/heap.cc` upstream).

`patch/Dockerfile` builds Node 24.21.0 from the release tarball with the patch applied
(`./configure --ninja`, default options). Result (`traces/24.21.0-patched-{log,trickle,silent}.log`,
one run each):

| idle mode | first reduce GC after burst end | heapUsed before→after | RSS at 155 s |
|---|---|---|---|
| log | **11 s** (`low alloc` at t=16.3) | 995 → 3.4 MB | 54 MB |
| silent | 11 s | 1056 → 3.1 MB | 54 MB |
| trickle | 11 s | 1122 → 3.1 MB | 59 MB |

First tick after the burst (t=8.2) is still `high alloc` (young/old terms still decaying); second tick
(t=16.3) is `low alloc` and starts the reduce GC; second reducer GC 600 ms later. With the patch
`HasLowEmbedderAllocationRate` returns before `ComputeMutatorUtilization`, so no
`Embedder mutator utilization` line is printed.

**Control** — same Dockerfile with `APPLY_PATCH=0` (identical source, toolchain, configure flags;
`traces/24.21.0-control-{log,trickle,silent}.log`):

| idle mode | first reduce GC after burst end | RSS at 155 s |
|---|---|---|
| log | 100 s (watchdog, `high alloc` every tick) | 60 MB |
| silent | 100 s (watchdog) | 59 MB |
| trickle | regular MC at 42.6 s (`pooled: 1269 MB`) resets the clock; watchdog reduce GC at 145.9 s | 64 MB |

Control behaves like the official binary; the only difference between control and patched is the
3-line change. Burst throughput was ~1000 chunks for both from-source builds when the host was idle
(see caveat below), so the earlier concern about build flags is moot.

Caveat on chunk counts: the baseline runs (9 containers in parallel on the same host) got through
~106 chunks in 5 s; runs with 3 containers in parallel got ~420 (official binary, `vm-*` modes, during a
build), ~830 (patched) to ~1000 (control) with the host otherwise idle. Host contention, not build
flags. Heap sizes differ accordingly; the comparison is about reducer behaviour, not throughput.

Alternative fix: skip the embedder term in `HasLowAllocationRate()` when `EmbedderAllocationCounter()`
has never been non-zero. Equivalent for Node; the patch above is smaller.

Not a fix: restoring the 1 B/ms floor on allocation throughput alone (see mechanism section).

## Prior reports

Searches performed (2026-10-06): nodejs/node issues+PRs via `gh search issues`; GitHub-wide issue
search; web search for the V8 symbol names; Gerrit search; issues.chromium.org (signed in) for
`"memory reducer"` (130 hits, titles skimmed), `HasLowAllocationRate OR HasLowEmbedderAllocationRate OR
SmoothedBytesAndDuration OR "mutator utilization" OR "embedder allocation"` (23 hits), node.js variants.

- None of those searches found a report of this mechanism.
- https://issues.chromium.org/issues/42204538 — ring-buffer latency complaint that the CL addresses
  (see above).
- https://issues.chromium.org/issues/372328123 "Unreferenced memory not returned to system heap in timely
  fashion" (WAI; external ArrayBuffer accounting, fixed by CL 7054782). Comment #10 is a useful writeup
  of the reducer's scheduling conditions.
- https://issues.chromium.org/issues/477038691 "Improve GC scheduling" (umbrella for the 1 s
  decline-decay CL); https://issues.chromium.org/issues/482952911 "Delay Memory Reducer" (Chrome field
  trial, 15 s); https://issues.chromium.org/issues/465491623 "Trading off memory reducer GCs for more
  compaction". None mention the embedder term.
- nodejs/node: #60482, #63863, #65600 (external-memory / OOM reports, different triggers), #65353
  (reducer task delaying shutdown).
- denoland/deno#34727 works around idle memory retention with `low_memory_notification`; no root cause
  given there.

## Unverified notes

- Underflow to exactly 0.0 after ~110 s without allocation is now demonstrated for the *embedder*
  tracker (`vm-once-reburst`). The young/old trackers could in principle do the same, but a positive
  rate passes the 0.993 test long before that, so a real failure there needs an explanation for why the
  reducer didn't start earlier (e.g. it was in `kDone` and a later major GC re-armed it after >110 s of
  no JS allocation — which no JS process does). Not observed.
- Whether Chromium is affected is not measured; Blink's cppgc allocation presumably keeps the embedder
  tracker non-zero but nothing here shows that.
