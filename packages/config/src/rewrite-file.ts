import { randomUUID } from "node:crypto";
import { readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { rewriteLegacyConfig } from "./rewrite-config";

/** Rewrite a copy or atomically replace the input after saving a private backup. */
export function rewriteConfigFile(
	input: string,
	output?: string,
): { changed: boolean; backup?: string } {
	if (output !== undefined && resolve(input) === resolve(output))
		throw new Error("Input and output must be different files");
	const original = readFileSync(input, "utf8");
	const data: unknown = JSON.parse(original);
	const rewritten = rewriteLegacyConfig(data);
	const result = `${JSON.stringify(rewritten, null, 2)}\n`;
	if (output !== undefined) {
		writeFileSync(output, result, {
			encoding: "utf8",
			mode: 0o600,
			flag: "wx",
		});
		return { changed: true };
	}
	if (
		!["team_routing", "provider_pools", "block_when_all_full"].some((key) =>
			Object.hasOwn(data as object, key),
		)
	)
		return { changed: false };
	const backup = `${input}.backup`;
	writeFileSync(backup, original, {
		encoding: "utf8",
		mode: 0o600,
		flag: "wx",
	});
	const temporary = join(
		dirname(input),
		`.${basename(input)}.${randomUUID()}.tmp`,
	);
	try {
		writeFileSync(temporary, result, {
			encoding: "utf8",
			mode: 0o600,
			flag: "wx",
		});
		renameSync(temporary, input);
	} catch (error) {
		try {
			unlinkSync(temporary);
		} catch {
			/* The temporary file may not exist. */
		}
		throw error;
	}
	return { changed: true, backup };
}
