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

function requirePrivateFile(path: string, expected: string): void {
	const file = lstatSync(path);
	if (
		!file.isFile() ||
		(file.mode & 0o077) !== 0 ||
		(typeof process.getuid === "function" && file.uid !== process.getuid()) ||
		readFileSync(path, "utf8") !== expected
	)
		throw new Error(`Existing migration file cannot safely be reused: ${path}`);
}

function waitForOwner(
	lock: string,
	input: string,
	destination: string,
	original: string,
): boolean {
	const delay = new Int32Array(new SharedArrayBuffer(4));
	const deadline = Date.now() + 30_000;
	while (true) {
		if (realpathSync(input) !== destination) return true;
		const current = readFileSync(destination, "utf8");
		if (current !== original) {
			const parsed: unknown = JSON.parse(current);
			if (!hasLegacyConfig(parsed)) return true;
			throw new Error("Config changed while it was being rewritten");
		}
		if (Date.now() >= deadline)
			throw new Error(
				`Config rewrite is still running; check the owner of ${lock} before retrying`,
			);
		let owner: unknown;
		let file: ReturnType<typeof lstatSync>;
		try {
			file = lstatSync(lock);
			if (
				!file.isFile() ||
				(file.mode & 0o077) !== 0 ||
				(typeof process.getuid === "function" && file.uid !== process.getuid())
			)
				throw new Error(`Unsafe config rewrite lock: ${lock}`);
			owner = JSON.parse(readFileSync(lock, "utf8"));
		} catch (error) {
			if (isFileError(error, "ENOENT")) return false;
			throw error;
		}
		if (
			typeof owner !== "object" ||
			owner === null ||
			!("pid" in owner) ||
			!Number.isInteger(owner.pid) ||
			(owner.pid as number) <= 0
		)
			throw new Error(`Invalid config rewrite lock: ${lock}`);
		try {
			process.kill(owner.pid as number, 0);
		} catch (error) {
			if (isFileError(error, "ESRCH")) {
				if (realpathSync(input) !== destination) return true;
				const after = readFileSync(destination, "utf8");
				if (after !== original) {
					if (!hasLegacyConfig(JSON.parse(after) as unknown)) return true;
					throw new Error("Config changed while it was being rewritten");
				}
				try {
					const currentLock = lstatSync(lock);
					if (currentLock.dev !== file.dev || currentLock.ino !== file.ino)
						return false;
				} catch (lockError) {
					if (isFileError(lockError, "ENOENT")) return false;
					throw lockError;
				}
				throw new Error(
					`A stopped process left config rewrite lock ${lock}; remove it after confirming no rewrite is running`,
				);
			}
			if (!isFileError(error, "EPERM")) throw error;
		}
		Atomics.wait(delay, 0, 0, 10);
	}
}

/** Rewrite a copy or atomically replace the input after saving a private backup. */
export function rewriteConfigFile(
	input: string,
	output?: string,
	options: { allowConcurrent?: boolean } = {},
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
	const backup = `${destination}.backup`;
	const token = randomUUID();
	const backupTemp = join(
		dirname(destination),
		`.${basename(destination)}.${token}.backup.tmp`,
	);
	const temporary = join(
		dirname(destination),
		`.${basename(destination)}.${token}.tmp`,
	);
	const lockTemp = join(
		dirname(destination),
		`.${basename(destination)}.${token}.lock.tmp`,
	);
	const lock = join(
		dirname(destination),
		`.${basename(destination)}.rewrite.lock`,
	);
	let ownsLock = false;
	const state = (): "original" | "new" => {
		if (realpathSync(input) !== destination)
			throw new Error("Config path changed while rewriting");
		const current = readFileSync(destination, "utf8");
		const metadata = statSync(destination);
		if (
			current === original &&
			metadata.dev === initial.dev &&
			metadata.ino === initial.ino
		)
			return "original";
		const parsed: unknown = JSON.parse(current);
		if (!hasLegacyConfig(parsed)) return "new";
		throw new Error("Config changed while it was being rewritten");
	};
	try {
		writeFileSync(lockTemp, JSON.stringify({ pid: process.pid }), {
			encoding: "utf8",
			mode: 0o600,
			flag: "wx",
		});
		while (true) {
			try {
				linkSync(lockTemp, lock);
				ownsLock = true;
				break;
			} catch (error) {
				if (!options.allowConcurrent || !isFileError(error, "EEXIST"))
					throw error;
				if (waitForOwner(lock, input, destination, original))
					return { changed: false };
			}
		}
		if (state() === "new") return { changed: false };
		writeFileSync(backupTemp, original, {
			encoding: "utf8",
			mode: 0o600,
			flag: "wx",
		});
		try {
			linkSync(backupTemp, backup);
		} catch (error) {
			if (!options.allowConcurrent || !isFileError(error, "EEXIST"))
				throw error;
			requirePrivateFile(backup, original);
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
		if (ownsLock) {
			try {
				const marker = lstatSync(lock),
					local = lstatSync(lockTemp);
				if (marker.dev === local.dev && marker.ino === local.ino)
					unlinkSync(lock);
			} catch {
				/* The lock may already have been removed. */
			}
		}
		for (const path of [lockTemp, backupTemp, temporary]) {
			try {
				unlinkSync(path);
			} catch {
				/* A temporary file may not exist. */
			}
		}
	}
}
