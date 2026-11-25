import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { rewriteLegacyConfig } from "./rewrite-config";

/** Writes a separate owner-only file; the original is kept intact for rollback. */
export function rewriteConfigFile(input: string, output: string): void {
	if (resolve(input) === resolve(output))
		throw new Error("Input and output must be different files");
	const parsed: unknown = JSON.parse(readFileSync(input, "utf8"));
	const rewritten = rewriteLegacyConfig(parsed);
	writeFileSync(output, `${JSON.stringify(rewritten, null, 2)}\n`, {
		encoding: "utf8",
		mode: 0o600,
		flag: "wx",
	});
}

if (import.meta.main) {
	try {
		const [input, output, ...rest] = process.argv.slice(2);
		if (!input || !output || rest.length)
			throw new Error(
				"Usage: bun run packages/config/src/rewrite-config-cli.ts <old.json> <new.json>",
			);
		rewriteConfigFile(input, output);
		console.log("Rewritten configuration saved; the input was not changed.");
	} catch (error) {
		console.error(
			error instanceof Error
				? error.message
				: "Could not rewrite configuration",
		);
		process.exitCode = 1;
	}
}
