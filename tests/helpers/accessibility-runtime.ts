import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

/** Test-only timing control after an actual native engine result, never fake output. */
export function accessibilityRuntime(profile: string, installed: string, holdAll = false) {
  const directory = path.join(profile, "runtime"); mkdirSync(directory);
  const pidFile = path.join(profile, "births.jsonl"), held = path.join(profile, "held"), release = path.join(profile, "release");
  writeFileSync(path.join(directory, "package.json"), JSON.stringify({ name: "playwright", version: "1.62.1", type: "module" }));
  writeFileSync(path.join(directory, "index.mjs"), `import * as real from ${JSON.stringify(installed)};import {appendFileSync,writeFileSync,existsSync} from 'node:fs';import {spawnSync} from 'node:child_process';
const wrap=engine=>({...engine,connectOverCDP:engine.connectOverCDP?.bind(engine),launchServer:async options=>{const server=await engine.launchServer(options),pid=server.process().pid;appendFileSync(${JSON.stringify(pidFile)},JSON.stringify({pid,started:Date.now(),engine:engine.name(),configuredExecutable:engine.executablePath(),actualBirthAndCommand:spawnSync('ps',['-p',String(pid),'-o','lstart=,command='],{encoding:'utf8'}).stdout.trim()})+'\\n');return server},connect:async(...args)=>{const browser=await engine.connect(...args),create=browser.newContext.bind(browser);browser.newContext=async(...options)=>{const context=await create(...options),cdp=context.newCDPSession.bind(context);context.newCDPSession=async page=>{const session=await cdp(page),send=session.send.bind(session);session.send=async(method,params)=>{const result=await send(method,params);if(method==='Runtime.evaluate'&&params?.awaitPromise===true&&(${JSON.stringify(holdAll)}||new URL(page.url()).pathname==='/hold-engine')){writeFileSync(${JSON.stringify(held)},'real-engine-completed');while(!existsSync(${JSON.stringify(release)}))await new Promise(resolve=>setTimeout(resolve,10))}return result};return session};return context};return browser}});
export const chromium=wrap(real.chromium),firefox=wrap(real.firefox),webkit=wrap(real.webkit);`);
  return { module: path.join(directory, "index.mjs"), pidFile, held, release };
}
