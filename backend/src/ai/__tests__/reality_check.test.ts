import { computeDelta, aggregateOutcome } from "../reality_check";

describe("computeDelta", () => {
  it("returns null delta when benchmark range is missing", () => {
    const r = computeDelta(100_000, null, null);
    expect(r.deltaPct).toBeNull();
    expect(r.benchmarkMidpoint).toBeNull();
    expect(r.exceedsThreshold).toBe(false);
  });

  it("computes a positive delta when proposer is above midpoint", () => {
    const r = computeDelta(180_000, 96_000, 120_000);
    expect(r.benchmarkMidpoint).toBe(108_000);
    expect(r.deltaPct).toBeCloseTo(66.67, 1);
    expect(r.exceedsThreshold).toBe(true); // way above default 25%
  });

  it("computes a negative delta when proposer is below midpoint", () => {
    const r = computeDelta(80_000, 90_000, 110_000);
    expect(r.benchmarkMidpoint).toBe(100_000);
    expect(r.deltaPct).toBeCloseTo(-20, 1);
    expect(r.exceedsThreshold).toBe(false); // 20% < 25%
  });

  it("stays under threshold when proposer is within the band", () => {
    const r = computeDelta(105_000, 100_000, 110_000);
    expect(r.benchmarkMidpoint).toBe(105_000);
    expect(r.deltaPct).toBeCloseTo(0, 2);
    expect(r.exceedsThreshold).toBe(false);
  });

  it("respects a custom threshold", () => {
    // 10% delta — under default 25%, but over a custom 5% threshold
    const r10 = computeDelta(110_000, 95_000, 105_000);
    expect(r10.exceedsThreshold).toBe(false);
    const rTight = computeDelta(110_000, 95_000, 105_000, 0.05);
    expect(rTight.exceedsThreshold).toBe(true);
  });

  it("handles a zero-midpoint benchmark gracefully", () => {
    const r = computeDelta(100, 0, 0);
    expect(r.deltaPct).toBeNull();
    expect(r.exceedsThreshold).toBe(false);
  });
});

describe("aggregateOutcome", () => {
  it("returns adjust_required when overall confidence is low", () => {
    const out = aggregateOutcome([{ deltaPct: 5, exceedsThreshold: false, benchmarkMidpoint: 100 }], 0.2);
    expect(out.state).toBe("adjust_required");
    expect(out.reason).toBe("low_confidence");
  });

  it("returns adjust_required when any item exceeds threshold", () => {
    const out = aggregateOutcome(
      [
        { deltaPct: 5, exceedsThreshold: false, benchmarkMidpoint: 100 },
        { deltaPct: 60, exceedsThreshold: true, benchmarkMidpoint: 100 },
      ],
      0.85
    );
    expect(out.state).toBe("adjust_required");
    expect(out.reason).toBe("delta_exceeded");
  });

  it("returns pass when confidence is high and no item exceeds threshold", () => {
    const out = aggregateOutcome(
      [
        { deltaPct: 3, exceedsThreshold: false, benchmarkMidpoint: 100 },
        { deltaPct: -10, exceedsThreshold: false, benchmarkMidpoint: 100 },
      ],
      0.9
    );
    expect(out.state).toBe("pass");
    expect(out.reason).toBe("within_threshold");
  });

  it("returns pass for an empty item list when confidence is high", () => {
    const out = aggregateOutcome([], 0.9);
    expect(out.state).toBe("pass");
  });
});
