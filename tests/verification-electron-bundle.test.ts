import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { copyElectronBundle } from "./fixtures/electron/bundle";

test.skipIf(process.platform === "win32")("a copied versioned framework keeps resources inside its app after the source is removed", () => {
  const temporary = mkdtempSync(path.join(os.tmpdir(), "rp-f39-bundle-"));
  const source = path.join(temporary, "Electron.app"), destination = path.join(temporary, "CooperatingFixture.app");
  const relativeFramework = "Contents/Frameworks/Electron Framework.framework";
  const framework = path.join(source, relativeFramework), copiedFramework = path.join(destination, relativeFramework);
  try {
    mkdirSync(path.join(framework, "Versions/A/Resources"), { recursive: true });
    writeFileSync(path.join(framework, "Versions/A/Resources/icudtl.dat"), "private-fixture-icu-resource");
    symlinkSync("A", path.join(framework, "Versions/Current"));
    symlinkSync("Versions/Current/Resources", path.join(framework, "Resources"));
    copyElectronBundle(source, destination);
    rmSync(source, { recursive: true });
    expect(readlinkSync(path.join(copiedFramework, "Versions/Current"))).toBe("A");
    expect(readlinkSync(path.join(copiedFramework, "Resources"))).toBe("Versions/Current/Resources");
    const resource = path.join(copiedFramework, "Resources/icudtl.dat");
    expect(realpathSync(resource)).toBe(path.join(realpathSync(destination), relativeFramework, "Versions/A/Resources/icudtl.dat"));
    expect(readFileSync(resource, "utf8")).toBe("private-fixture-icu-resource");
  } finally { rmSync(temporary, { recursive: true, force: true }); }
});
