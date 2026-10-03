import { cwd } from "node:process";
import { Generator, getConfig } from "@tanstack/router-generator";

const root = cwd();
await new Generator({ config: getConfig({}, root), root }).run();
