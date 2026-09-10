/**
 * Ambient types for the build-time-generated `skills.compiled.ts`.
 *
 * `scripts/embed-skills.ts` writes a sibling `skills.compiled.ts` (gitignored)
 * before `bun build --compile`, exporting the same `EMBEDDED_SKILLS` map. This
 * declaration lets `bun x tsc --noEmit` resolve the dynamic import in
 * `src/init-skills.ts` without requiring the generated file to exist on disk
 * — TypeScript prefers a real `.ts` over a `.d.ts` when both are present, so
 * the embed step still feeds tsc the actual content during builds.
 */
export const EMBEDDED_SKILLS: Record<string, string>;
