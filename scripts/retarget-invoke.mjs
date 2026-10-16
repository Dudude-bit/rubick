// The generated bindings call Tauri's invoke directly, and the generator has
// no option to say otherwise. Pointing that one import at the transport is
// what puts every command behind it; see src/ui/lib/transport.
import { readFileSync, writeFileSync } from "node:fs";
import { exit, stderr } from "node:process";

const FILE = "src/ui/generated/commands.ts";
const FROM = 'import { invoke } from "@tauri-apps/api/core";';
const TO = 'import { invoke } from "@/lib/transport";';

const source = readFileSync(FILE, "utf8");
if (!source.includes(FROM)) {
  stderr.write(
    `${FILE}: expected the line ${FROM} from the generator and did not find it. ` +
      "If it now imports more than invoke from Tauri, decide where that goes before regenerating.\n"
  );
  exit(1);
}
writeFileSync(FILE, source.replace(FROM, TO));
