// Delta-debugging shrinker for a failing string (ddmin over characters): removes ever
// smaller chunks while the input still fails, until no single character can go.
export function shrinkString(input, fails, maxSteps = 5_000) {
  let current = input;
  let chunk = Math.max(1, Math.floor(current.length / 2));
  let steps = 0;
  while (chunk >= 1 && steps < maxSteps) {
    let removed = false;
    for (let start = 0; start < current.length && steps < maxSteps; start += chunk) {
      steps += 1;
      const candidate = current.slice(0, start) + current.slice(start + chunk);
      if (candidate !== "" && fails(candidate)) {
        current = candidate;
        removed = true;
        start -= chunk;
      }
    }
    if (!removed) chunk = Math.floor(chunk / 2);
  }
  return current;
}
