// Code-unit string order: unlike localeCompare, independent of the process locale.
export function compareCodeUnits(left, right) {
  if (left < right) return -1;
  return left > right ? 1 : 0;
}
