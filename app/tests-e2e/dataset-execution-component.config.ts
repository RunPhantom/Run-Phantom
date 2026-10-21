import path from "node:path";
import { defineConfig } from "@playwright/test";
export default defineConfig({testDir:".",testMatch:"dataset-execution.spec.ts",workers:1,retries:0,fullyParallel:false,timeout:90000,reporter:[["list"],["json",{outputFile:process.env.F46_PW_JSON}]],
 use:{baseURL:"http://127.0.0.1:17446",headless:true,viewport:{width:1440,height:900},screenshot:"only-on-failure",actionTimeout:15000,navigationTimeout:20000},
 webServer:{cwd:path.resolve(import.meta.dirname,".."),command:"bun tests-e2e/dataset-execution-component-server.ts",url:"http://127.0.0.1:17446/tests-e2e/dataset-execution-component.html",reuseExistingServer:false,timeout:30000}});
