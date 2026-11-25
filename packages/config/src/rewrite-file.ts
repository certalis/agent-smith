import { randomUUID } from "node:crypto";
import {
	accessSync,
	constants,
	linkSync,
	lstatSync,
	readFileSync,
	realpathSync,
	renameSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { rewriteLegacyConfig } from "./rewrite-config";

export function hasLegacyConfig(value: unknown): boolean {
	return (
		typeof value === "object" &&
		value !== null &&
		!Array.isArray(value) &&
		["team_routing", "provider_pools", "block_when_all_full"].some((key) =>
			Object.hasOwn(value, key),
		)
	);
}

function isFileError(error: unknown, code: string): boolean {
	return error instanceof Error && "code" in error && error.code === code;
}

function matchesPrivateBackup(path: string, expected: string): boolean {
	try {
		const file = lstatSync(path);
		return (
			file.isFile() &&
			(file.mode & 0o077) === 0 &&
			(typeof process.getuid !== "function" || file.uid === process.getuid()) &&
			readFileSync(path, "utf8") === expected
		);
	} catch {
		return false;
	}
}

/** Rewrite a copy or atomically replace the input after saving a private backup. */
export function rewriteConfigFile(
	input: string,
	output?: string,
): { changed: boolean; backup?: string } {
	if (output !== undefined && resolve(input) === resolve(output))
		throw new Error("Input and output must be different files");
	const destination = realpathSync(input);
	const initial = statSync(destination);
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
	if (!hasLegacyConfig(data)) return { changed: false };
	if ((initial.mode & 0o222) === 0) throw new Error("Config file is read-only");
	accessSync(destination, constants.W_OK);
	const token = randomUUID();
	const backupTemp = join(
		dirname(destination),
		`.${basename(destination)}.${token}.backup.tmp`,
	);
	const temporary = join(
		dirname(destination),
		`.${basename(destination)}.${token}.tmp`,
	);
	const state = (): "original" | "new" => {
		if (realpathSync(input) !== destination)
			throw new Error("Config path changed while rewriting");
		const current = readFileSync(destination, "utf8");
		if (current === original) return "original";
		const parsed: unknown = JSON.parse(current);
		if (!hasLegacyConfig(parsed)) return "new";
		throw new Error("Config changed while it was being rewritten");
	};
	try {
		if (state() === "new") return { changed: false };
		writeFileSync(backupTemp, original, {
			encoding: "utf8",
			mode: 0o600,
			flag: "wx",
		});
		const base = `${destination}.backup`;
		const stamp = new Date().toISOString().replace(/[:.]/g, "-");
		let backup = base;
		for (let attempt = 0; ; attempt++) {
			try {
				linkSync(backupTemp, backup);
				break;
			} catch (error) {
				if (!isFileError(error, "EEXIST")) throw error;
				if (matchesPrivateBackup(backup, original)) break;
				backup = `${base}-${stamp}${attempt === 0 ? "" : `-${attempt}`}`;
			}
		}
		writeFileSync(temporary, result, {
			encoding: "utf8",
			mode: 0o600,
			flag: "wx",
		});
		if (state() === "new") return { changed: false };
		renameSync(temporary, destination);
		return { changed: true, backup };
	} finally {
		for (const path of [backupTemp, temporary]) {
			try {
				unlinkSync(path);
			} catch {
				/* A temporary file may not exist. */
			}
		}
	}
}
