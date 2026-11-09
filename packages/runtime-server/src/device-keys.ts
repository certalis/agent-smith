import { createHash, timingSafeEqual } from "node:crypto";
import {
	closeSync,
	constants,
	fstatSync,
	openSync,
	readFileSync,
} from "node:fs";
import { isAbsolute } from "node:path";

const MAX_REGISTRY_BYTES = 32 * 1024;
const MAX_DEVICES = 128;

export function deviceKeyMatches(
	key: string | null,
	path: string | undefined,
): boolean {
	if (!key || !path || !isAbsolute(path) || !/^[\x21-\x7e]{32,512}$/.test(key))
		return false;
	let fd: number | undefined;
	try {
		fd = openSync(
			path,
			constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
		);
		const stat = fstatSync(fd);
		if (
			!stat.isFile() ||
			stat.size > MAX_REGISTRY_BYTES ||
			(stat.mode & 0o077) !== 0 ||
			(stat.uid !== process.getuid?.() && stat.uid !== 0)
		)
			return false;
		const registry: unknown = JSON.parse(readFileSync(fd, "utf8"));
		if (!registry || typeof registry !== "object" || Array.isArray(registry))
			return false;
		const entries = Object.entries(registry);
		if (
			entries.length > MAX_DEVICES ||
			entries.some(
				([name, digest]) =>
					!/^[-a-zA-Z0-9_]{1,64}$/.test(name) ||
					typeof digest !== "string" ||
					!/^[a-f0-9]{64}$/.test(digest),
			)
		)
			return false;
		const digest = createHash("sha256").update(key).digest();
		return entries.some(([, expected]) =>
			timingSafeEqual(digest, Buffer.from(expected, "hex")),
		);
	} catch {
		return false;
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}
