import { cpSync } from "node:fs";

export function copyElectronBundle(source: string, destination: string): void {
  // Versioned framework links must stay relative to the copied app's resources.
  cpSync(source, destination, { recursive: true, dereference: false, verbatimSymlinks: true });
}
