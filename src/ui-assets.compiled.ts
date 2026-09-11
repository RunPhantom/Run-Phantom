/**
 * Compiled-binary-only UI asset embed.
 *
 * Isolated into its own module so source-mode runs (`bun test`,
 * `bun src/index.ts ...`) never touch the asset import. The static
 * `with { type: "file" }` attribute requires `build/ui-bundle.tgz` to exist
 * at module-load time, and that file is only present after
 * `scripts/build-bun.ts` has run. By gating the import behind a lazy
 * `require("./ui-assets.compiled")` from src/ui-assets.ts (only reached
 * when running as the compiled `runphantom` binary), we keep tests
 * resilient to a missing build artifact while preserving Bun's
 * compile-time embedding for production binaries.
 *
 * `bun build --compile` follows static-string `require()` calls during
 * dependency analysis, so this module and its embedded asset are pulled
 * into the compiled binary correctly. See scripts/build-bun.ts for the
 * producer side and src/embeds.d.ts for the tsc-side ambient `*.tgz`
 * module declaration.
 */
import bundlePath from "../build/ui-bundle.tgz" with { type: "file" };

export { bundlePath };
