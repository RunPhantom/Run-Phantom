import os from "os";
import path from "path";
import { defineConfig } from "drizzle-kit";

const dbPath =
  process.env.RUNPHANTOM_DB_PATH ||
  path.join(os.homedir(), ".runphantom", "runphantom.db");

export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "sqlite",
  dbCredentials: {
    url: dbPath,
  },
});
