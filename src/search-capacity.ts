const occupied = { local: 0, team: 0 };
export type SearchCapacityScope = keyof typeof occupied;
export function searchCapacity(scope: SearchCapacityScope): number { return occupied[scope]; }
export function acquireSearchCapacity(scope: SearchCapacityScope, limit: number): (() => void) | null {
  if (occupied[scope] >= limit) return null;
  occupied[scope]++;
  let released = false;
  return () => { if (!released) { released = true; occupied[scope]--; } };
}
