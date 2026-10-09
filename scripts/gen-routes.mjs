import { join } from "node:path";
import { cwd } from "node:process";
import { Generator, getConfig } from "@tanstack/router-generator";

// The UI's folder, where Vite's root and tsr.config.json are.
const root = join(cwd(), "src/ui");
await new Generator({ config: getConfig({}, root), root }).run();
