import { rm, stat } from "node:fs/promises";

// Call only after the owned process and database handles have closed.
export async function removeOwnedDirectory(directory: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try { await rm(directory, { recursive: true, force: true }); break; }
    catch (error) {
      if (attempt >= 9 || !["EBUSY", "EPERM", "ENOTEMPTY"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
      await new Promise<void>(resolve => setTimeout(resolve, 100));
    }
  }
  try { await stat(directory); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  throw new Error("fixture_directory_not_removed");
}
