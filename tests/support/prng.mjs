// Seeded, dependency-free PRNG for generated (property-style) tests.
// mulberry32: small, fast, and identical on every platform for a given seed.
export function createPrng(seed) {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (min, max) => min + Math.floor(next() * (max - min + 1));
  const pick = (values) => values[int(0, values.length - 1)];
  const shuffle = (values) => {
    const copy = [...values];
    for (let index = copy.length - 1; index > 0; index -= 1) {
      const swap = int(0, index);
      [copy[index], copy[swap]] = [copy[swap], copy[index]];
    }
    return copy;
  };
  return { next, int, pick, shuffle };
}

// Seeds come from LILAC_PROPERTY_SEED (to replay one failure) or a fixed list.
export function propertySeeds(count) {
  const pinned = process.env.LILAC_PROPERTY_SEED;
  if (pinned !== undefined && pinned !== "") {
    const seed = Number(pinned);
    if (!/^\d+$/u.test(pinned) || !Number.isSafeInteger(seed)) throw new Error(`LILAC_PROPERTY_SEED must be a decimal integer, got ${JSON.stringify(pinned)}`);
    return [seed];
  }
  return Array.from({ length: count }, (_, index) => 0x5eed + index * 7919);
}
