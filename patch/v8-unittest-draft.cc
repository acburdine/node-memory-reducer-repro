// Draft regression test for crbug.com/570738027, for
// test/unittests/heap/heap-unittest.cc (fixture: HeapTest =
// TestWithHeapInternalsAndContext; gc-tracer.h is already included there).
//
// Uses only public Heap API: Heap::HasLowAllocationRate() is public,
// HasLowEmbedderAllocationRate() is private. Young/old are given a small
// positive rate so that only the embedder term decides the result.
//
// Numbers: after ResetForTesting() no GC speeds are recorded, so
// ComputeMutatorUtilizationImpl() falls back to 200000 B/ms for gc_speed.
// 100 bytes over 100 ms is ~0.5 B/ms after smoothing, giving
// mu = 200000 / (0.5 + 200000) > 0.993 for young and old.

TEST_F(HeapTest, LowAllocationRateWithZeroEmbedderAllocation) {
  if (v8_flags.stress_incremental_marking) return;
  Heap* heap = i_isolate()->heap();
  GCTracer* tracer = heap->tracer();
  tracer->ResetForTesting();

  // Two samples 100 ms apart. Young and old generation allocate a little;
  // the embedder (CppHeap) and external memory allocate nothing at all, as
  // in an embedder that never uses cppgc (e.g. Node.js without node:vm).
  tracer->SampleAllocation(base::TimeTicks::FromMsTicksForTesting(0), 0, 0, 0,
                           0);
  tracer->SampleAllocation(base::TimeTicks::FromMsTicksForTesting(100), 100,
                           100, 0, 0);

  EXPECT_DOUBLE_EQ(0.0,
                   tracer->EmbedderAllocationThroughputInBytesPerMillisecond());
  // Before the fix this was false: a throughput of exactly 0 was mapped to a
  // mutator utilization of 0 and the memory reducer never saw "low alloc".
  EXPECT_TRUE(heap->HasLowAllocationRate());
}

TEST_F(HeapTest, HighAllocationRateWithEmbedderAllocation) {
  if (v8_flags.stress_incremental_marking) return;
  Heap* heap = i_isolate()->heap();
  GCTracer* tracer = heap->tracer();
  tracer->ResetForTesting();

  // Same as above, but the embedder allocates heavily: 1 GB over 100 ms is
  // ~10^7 B/ms, so the embedder term must still report a high allocation
  // rate (mu = 200000 / (10^7 + 200000) < 0.993).
  tracer->SampleAllocation(base::TimeTicks::FromMsTicksForTesting(0), 0, 0, 0,
                           0);
  tracer->SampleAllocation(base::TimeTicks::FromMsTicksForTesting(100), 100,
                           100, size_t{1} << 30, 0);

  EXPECT_GT(tracer->EmbedderAllocationThroughputInBytesPerMillisecond(), 0.0);
  EXPECT_FALSE(heap->HasLowAllocationRate());
}
