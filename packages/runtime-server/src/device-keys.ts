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

/** Resolve a private registry owner, never an identity claimed by the client. */
export function deviceKeyCallerId(
	key: string | null,
	path: string | undefined,
): string | null {
	if (!key || !path || !isAbsolute(path) || !/^[\x21-\x7e]{32,512}$/.test(key))
		return null;
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
			return null;
		const registry: unknown = JSON.parse(readFileSync(fd, "utf8"));
		if (!registry || typeof registry !== "object" || Array.isArray(registry))
			return null;
		const entries = Object.entries(registry);
		if (entries.length > MAX_DEVICES) return null;
		const owners: Array<{ digest: string; callerId: string }> = [];
		const seen = new Set<string>();
		const validName = /^[-a-zA-Z0-9_]{1,64}$/;
		for (const [name, entry] of entries) {
			if (!validName.test(name)) return null;
			const value =
				typeof entry === "string" ? { sha256: entry, callerId: name } : entry;
			if (
				!value ||
				typeof value !== "object" ||
				Array.isArray(value) ||
				Object.keys(value).some((key) => key !== "sha256" && key !== "callerId")
			)
				return null;
			const { sha256, callerId } = value as Record<string, unknown>;
			if (
				typeof sha256 !== "string" ||
				!/^[a-f0-9]{64}$/.test(sha256) ||
				typeof callerId !== "string" ||
				!validName.test(callerId) ||
				seen.has(sha256)
			)
				return null;
			seen.add(sha256);
			owners.push({ digest: sha256, callerId });
		}
		const digest = createHash("sha256").update(key).digest();
		return (
			owners.find((owner) =>
				timingSafeEqual(digest, Buffer.from(owner.digest, "hex")),
			)?.callerId ?? null
		);
	} catch {
		return null;
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}
