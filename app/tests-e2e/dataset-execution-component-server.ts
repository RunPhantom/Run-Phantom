// Private inactive UI fixture: permit the existing dependency symlink's real font path.
import path from "node:path";
import { realpathSync } from "node:fs";
import { createServer } from "vite";
const server=await createServer({root:path.resolve(import.meta.dirname,".."),server:{host:"127.0.0.1",port:17446,strictPort:true,fs:{allow:[path.resolve(import.meta.dirname,"../.."),realpathSync(path.resolve(import.meta.dirname,"../../node_modules"))]}}});
await server.listen();
const stop=async()=>{await server.close();process.exit(0);};process.on("SIGTERM",()=>{void stop();});process.on("SIGINT",()=>{void stop();});
