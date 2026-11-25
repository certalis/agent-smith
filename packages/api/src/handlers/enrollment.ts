import { createHash, randomBytes } from "node:crypto";
import { ValidationError } from "@agent-smith/core";
import {
	type OAuthAuthorization,
	OAuthFlow,
	type VerifiedClaudeSeat,
} from "@agent-smith/oauth-flow";
import { type Account, isRecord } from "@agent-smith/types";
import type { APIContext } from "../types";
import { enrollmentPage } from "./enrollment-page";

const paths = new Set([
	"/pool-enroll",
	"/pool-enroll/request",
	"/pool-enroll/start",
	"/pool-enroll/verify",
	"/pool-enroll/confirm",
	"/pool-enroll/disconnect",
	"/pool-enroll/resume",
	"/pool-enroll/reset",
]);
const tenMinutes = 600_000;
const oneDay = 86_400_000;
type Details = {
	name: string;
	email?: string;
	contactEmail?: string;
	slackUserId?: string;
	reconnect?: {
		id: string;
		accountUuid: string | null;
		organizationUuid: string | null;
	};
};
type State =
	| { kind: "invited" }
	| { kind: "started"; flow: OAuthAuthorization }
	| { kind: "verified"; seat: VerifiedClaudeSeat }
	| { kind: "connected"; accountId: string; accountUuid: string; email: string }
	| { kind: "busy" };
type Entry = {
	details: Details;
	expiresAt: number;
	state: State;
	browserSession?: string;
};
const sessionCookie = "agent_smith_enrollment";
const headers = {
	"cache-control": "no-store",
	"referrer-policy": "no-referrer",
	"x-content-type-options": "nosniff",
};
const json = (value: unknown, status = 200) =>
	Response.json(value, { status, headers });
const hash = (token: string) =>
	createHash("sha256").update(token).digest("hex");

class EnrollmentError extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
	}
}

export function validateEnrollmentOrigin(value: string): URL {
	const origin = new URL(value);
	const loopback = ["127.0.0.1", "[::1]", "localhost"].includes(
		origin.hostname,
	);
	if (
		origin.origin !== value ||
		(origin.protocol !== "https:" && !(loopback && origin.protocol === "http:"))
	) {
		throw new Error(
			"Enrollment origin must be an exact HTTPS origin (HTTP loopback is test-only)",
		);
	}
	return origin;
}

/** Bounded, process-local capabilities. A restart revokes every pending invite. */
export class EnrollmentHandlers {
	private readonly entries = new Map<string, Entry>();
	private readonly origin: URL;
	private readonly oauth: OAuthFlow;
	private readonly now: () => number;
	constructor(
		private readonly context: APIContext,
		origin: string,
	) {
		this.origin = validateEnrollmentOrigin(origin);
		this.oauth = new OAuthFlow(
			context.dbOps,
			context.config,
			context.providerRegistry,
		);
		this.now = context.now ?? Date.now;
	}

	private prune(): void {
		for (const [key, entry] of this.entries)
			if (entry.expiresAt <= this.now()) this.entries.delete(key);
	}
	private mint(
		details: Details,
		state: State,
		duration: number,
		browserSession?: string,
	): { token: string; expiresAt: number } {
		const token = randomBytes(32).toString("base64url");
		const expiresAt = this.now() + duration;
		this.entries.set(hash(token), {
			details,
			state,
			expiresAt,
			browserSession,
		});
		return { token, expiresAt };
	}
	private cookieToken(req: Request): string {
		const cookies = (req.headers.get("cookie") ?? "")
			.split(";")
			.map((part) => part.trim())
			.filter((part) => part.startsWith(`${sessionCookie}=`));
		const token =
			cookies.length === 1
				? (cookies[0]?.slice(sessionCookie.length + 1) ?? "")
				: "";
		return /^[A-Za-z0-9_-]{43}$/.test(token) ? token : "";
	}
	private cookieHeader(token: string, duration: number): string {
		return `${sessionCookie}=${token}; Path=/pool-enroll; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(duration / 1000)}${this.origin.protocol === "https:" ? "; Secure" : ""}`;
	}
	private browserEntry(req: Request): [string, Entry] | undefined {
		const token = this.cookieToken(req);
		if (!token) return;
		const session = hash(token);
		return [...this.entries].find(
			([, entry]) => entry.browserSession === session,
		);
	}
	private mintBrowser(
		details: Details,
		state: State,
		duration: number,
		extra: Record<string, unknown>,
		session = randomBytes(32).toString("base64url"),
	): Response {
		const response = json({
			...this.mint(details, state, duration, hash(session)),
			...extra,
		});
		response.headers.set("set-cookie", this.cookieHeader(session, duration));
		return response;
	}
	private next(
		entry: Entry,
		state: State,
		duration: number,
		req: Request,
		extra: Record<string, unknown>,
	): Response {
		const session = this.cookieToken(req);
		return this.mintBrowser(
			entry.details,
			state,
			duration,
			extra,
			session && entry.browserSession === hash(session) ? session : undefined,
		);
	}
	private resume(req: Request): Response {
		const found = this.browserEntry(req);
		if (!found)
			throw new EnrollmentError(
				410,
				"No active sign-in. Enter your email to start again.",
			);
		const [, entry] = found;
		const { state, details, expiresAt } = entry;
		if (state.kind === "busy")
			throw new EnrollmentError(
				409,
				"Sign-in is being updated in another tab. Try resuming in a moment.",
			);
		if (state.kind === "connected") {
			const account = this.context.dbOps.getAccount(state.accountId);
			if (!account || account.account_uuid !== state.accountUuid)
				throw new EnrollmentError(
					410,
					"This subscription has changed or was removed. Start again.",
				);
		}
		return json({
			stage: state.kind,
			expiresAt,
			email:
				state.kind === "verified"
					? state.seat.identity.email
					: state.kind === "connected"
						? state.email
						: details.email,
			...(state.kind === "started" ? { authUrl: state.flow.authUrl } : {}),
			...(state.kind === "connected"
				? {
						reconnected: !!details.reconnect,
						...this.connectionStatus("claude-code", state.accountId),
					}
				: {}),
		});
	}
	private async guarded(action: () => Promise<Response>): Promise<Response> {
		try {
			this.prune();
			return await action();
		} catch (error) {
			return error instanceof EnrollmentError
				? json({ error: error.message }, error.status)
				: json(
						{
							error:
								"Enrollment could not be saved. Ask the operator to check the seat.",
						},
						500,
					);
		}
	}

	private requireClaudeCode(): void {
		if (!this.context.providerRegistry.getOAuthProvider("claude-code"))
			throw new EnrollmentError(
				400,
				"Provider 'claude-code' is disabled. Set providers.claude-code.enabled to true in your config.",
			);
	}
	/** Frees the seat name for one new sign-in: older pending entries for it are dropped. */
	private reserve(name: string, reconnect = false): void {
		if (!reconnect && this.context.dbOps.getAccountByName(name))
			throw new EnrollmentError(409, "This seat is already in the pool.");
		for (const entry of this.entries.values())
			if (entry.details.name === name && entry.state.kind === "busy")
				throw new EnrollmentError(409, "Sign-in is already in progress");
		for (const [key, entry] of this.entries)
			if (entry.details.name === name && entry.state.kind !== "connected")
				this.entries.delete(key);
		if (this.entries.size >= 100)
			throw new EnrollmentError(429, "Too many pending invitations");
	}

	/**
	 * Stable-link entry: an email/domain rule admits an invitation; it proves nothing.
	 * verify still requires the Claude sign-in to return this same email.
	 */
	private request(body: Record<string, unknown>): Response {
		this.requireClaudeCode();
		if (Object.keys(body).some((key) => key !== "email"))
			throw new EnrollmentError(400, "Unknown request field");
		const email =
			typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
		if (!this.context.config.isEnrollmentEmailAllowed(email))
			throw new EnrollmentError(
				403,
				"This email is not allowed. Ask the operator to add its address or domain.",
			);
		const name = email
			.slice(0, email.indexOf("@"))
			.replace(/[^a-z0-9._+-]/g, "-")
			.slice(0, 64);
		const { dbOps } = this.context;
		const contacts = dbOps
			.getAccountsByProvider("claude-code")
			.filter(
				(account) =>
					dbOps.getEnrollmentContact(account.id)?.email?.toLowerCase() ===
					email,
			);
		if (contacts.length > 1)
			throw new EnrollmentError(
				409,
				"This email matches several seats. Ask the operator to check them.",
			);
		const existing = contacts[0] ?? dbOps.getAccountByName(name);
		if (
			existing &&
			(existing.provider !== "claude-code" ||
				existing.auth_method !== "oauth" ||
				!existing.account_uuid)
		)
			throw new EnrollmentError(
				409,
				"This seat needs the operator's help to reconnect.",
			);
		const details: Details = {
			name: existing?.name ?? name,
			email,
			contactEmail: email,
			...(existing
				? {
						reconnect: {
							id: existing.id,
							accountUuid: existing.account_uuid ?? null,
							organizationUuid: existing.organization_uuid ?? null,
						},
					}
				: {}),
		};
		this.reserve(details.name, !!existing);
		return this.mintBrowser(details, { kind: "invited" }, tenMinutes, {
			email,
		});
	}

	/**
	 * Admin-only list edit; an empty body reads the list. POST even to read:
	 * GET /api/* is open to the proxy key, which must never see these emails.
	 */
	emails = (req: Request): Promise<Response> =>
		this.guarded(async () => {
			const body = await readBody(req);
			const lists = Object.entries(body);
			if (
				lists.some(
					([key, value]) =>
						(key !== "add" && key !== "remove") ||
						!Array.isArray(value) ||
						value.some((email) => typeof email !== "string"),
				)
			)
				throw new EnrollmentError(
					400,
					"Expected { add?: string[], remove?: string[] }",
				);
			const { config } = this.context;
			const add = (body.add ?? []) as string[];
			const remove = new Set(
				((body.remove ?? []) as string[]).map((email) =>
					email.trim().toLowerCase(),
				),
			);
			if (add.length === 0 && remove.size === 0)
				return json({ emails: config.getEnrollmentEmails() });
			const next = [...config.getEnrollmentEmails(), ...add].filter(
				(email) => !remove.has(email.trim().toLowerCase()),
			);
			try {
				return json({ emails: config.setEnrollmentEmails(next) });
			} catch (error) {
				if (error instanceof ValidationError)
					throw new EnrollmentError(400, error.message);
				throw error;
			}
		});

	/** Called only behind the existing management/admin-key boundary. */
	issue = (req: Request): Promise<Response> =>
		this.guarded(async () => {
			this.requireClaudeCode();
			const input = await readBody(req);
			const allowed = new Set(["name", "email", "contactEmail", "slackUserId"]);
			if (Object.keys(input).some((key) => !allowed.has(key)))
				throw new EnrollmentError(400, "Unknown invitation field");
			const details: Details = {
				name: `seat-${randomBytes(8).toString("hex")}`,
			};
			for (const key of [
				"name",
				"email",
				"contactEmail",
				"slackUserId",
			] as const) {
				const value = input[key];
				if (value === undefined) continue;
				if (
					typeof value !== "string" ||
					!value.trim() ||
					value.length > 254 ||
					Array.from(value).some(
						(char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127,
					)
				)
					throw new EnrollmentError(400, "Invalid invitation details");
				details[key] = value.trim();
			}
			if (
				details.name.length > 80 ||
				(details.slackUserId &&
					!/^U[A-Z0-9]{8,20}$/.test(details.slackUserId)) ||
				[details.email, details.contactEmail].some(
					(email) => email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email),
				)
			)
				throw new EnrollmentError(400, "Invalid invitation details");
			this.reserve(details.name);
			const issued = this.mint(details, { kind: "invited" }, oneDay);
			return json(
				{
					url: `${this.origin.origin}/pool-enroll#${issued.token}`,
					expiresAt: issued.expiresAt,
				},
				201,
			);
		});

	handlePublic(url: URL, req: Request): Promise<Response> | null {
		if (!paths.has(url.pathname)) return null;
		return this.guarded(async () => {
			if (
				url.host !== this.origin.host ||
				(req.headers.has("host") &&
					req.headers.get("host") !== this.origin.host)
			)
				throw new EnrollmentError(403, "Untrusted enrollment host");
			if (url.search) throw new EnrollmentError(400, "Invalid enrollment URL");
			if (req.method !== (url.pathname === "/pool-enroll" ? "GET" : "POST"))
				throw new EnrollmentError(405, "Method not allowed");
			if (url.pathname === "/pool-enroll") return enrollmentPage();
			if (req.headers.get("origin") !== this.origin.origin)
				throw new EnrollmentError(403, "Untrusted enrollment origin");
			const body = await readBody(req);
			if (url.pathname === "/pool-enroll/request") return this.request(body);
			if (
				url.pathname === "/pool-enroll/resume" ||
				url.pathname === "/pool-enroll/reset"
			) {
				if (Object.keys(body).length)
					throw new EnrollmentError(400, "No fields expected");
				if (url.pathname === "/pool-enroll/resume") return this.resume(req);
				const found = this.browserEntry(req);
				if (found) this.entries.delete(found[0]);
				const response = json({ reset: true });
				response.headers.set("set-cookie", this.cookieHeader("", 0));
				return response;
			}
			const token =
				typeof body.token === "string" && /^[A-Za-z0-9_-]{43}$/.test(body.token)
					? body.token
					: "";
			const [key, entry] =
				body.token === undefined
					? (this.browserEntry(req) ?? ["", undefined])
					: [hash(token), this.entries.get(hash(token))];
			const expected =
				url.pathname === "/pool-enroll/start"
					? "invited"
					: url.pathname === "/pool-enroll/verify"
						? "started"
						: url.pathname === "/pool-enroll/confirm"
							? "verified"
							: "connected";
			if (
				!entry ||
				entry.expiresAt <= this.now() ||
				entry.state.kind !== expected
			)
				throw new EnrollmentError(
					410,
					"This sign-in has expired or was already used. Start again.",
				);
			const state = entry.state;
			entry.state = { kind: "busy" }; // Claim before any await: duplicate clicks cannot exchange twice.
			try {
				if (state.kind === "invited") {
					const flow = await this.oauth.beginClaudeSeat();
					this.assertCurrent(key, entry);
					return this.next(entry, { kind: "started", flow }, tenMinutes, req, {
						authUrl: flow.authUrl,
					});
				}
				if (state.kind === "started") {
					if (typeof body.code !== "string" || body.code.length > 4096)
						throw new EnrollmentError(400, "Invalid authorization code");
					let seat: VerifiedClaudeSeat;
					try {
						seat = await this.oauth.verifyClaudeSeat(
							state.flow,
							body.code.trim(),
						);
					} catch {
						throw new EnrollmentError(
							400,
							"Claude sign-in could not be verified. Start again.",
						);
					}
					this.assertCurrent(key, entry);
					const { email } = seat.identity;
					if (
						!email ||
						(entry.details.email &&
							email.toLowerCase() !== entry.details.email.toLowerCase())
					)
						throw new EnrollmentError(
							400,
							"This Claude account does not match your email. Start again and sign in with the matching account.",
						);
					this.assertSeat(entry.details, seat);
					return this.next(entry, { kind: "verified", seat }, tenMinutes, req, {
						email,
					});
				}
				if (state.kind === "verified") {
					if (body.consent !== true)
						throw new EnrollmentError(
							400,
							"Confirm the displayed account before adding it",
						);
					const accountId = this.save(entry.details, state.seat);
					return this.next(
						entry,
						{
							kind: "connected",
							accountId,
							accountUuid: state.seat.identity.accountUuid,
							email: state.seat.identity.email ?? "",
						},
						oneDay,
						req,
						{
							connected: true,
							email: state.seat.identity.email,
							reconnected: !!entry.details.reconnect,
							...this.connectionStatus("claude-code", accountId),
						},
					);
				}
				if (state.kind === "connected") {
					try {
						this.remove(state.accountId, state.accountUuid);
					} catch (error) {
						if (error instanceof EnrollmentError) throw error;
						// A failed write rolls back deletion; keep the same removal authority.
						entry.state = state;
						throw new EnrollmentError(
							500,
							"Removal could not be saved. Retry here or ask the operator to check this seat.",
						);
					}
					return this.next(
						{ ...entry, details: { ...entry.details, reconnect: undefined } },
						{ kind: "invited" },
						oneDay,
						req,
						{
							disconnected: true,
						},
					);
				}
				throw new EnrollmentError(410, "Link already used");
			} finally {
				if (entry.state.kind === "busy") this.entries.delete(key);
			}
		});
	}

	private assertCurrent(key: string, entry: Entry): void {
		if (this.entries.get(key) !== entry || entry.expiresAt <= this.now())
			throw new EnrollmentError(410, "Sign-in expired. Start again.");
	}
	private assertSeat(
		details: Details,
		seat: VerifiedClaudeSeat,
	): Account | null {
		if (details.reconnect) {
			const account = this.context.dbOps.getAccount(details.reconnect.id);
			if (
				!account ||
				account.provider !== "claude-code" ||
				account.auth_method !== "oauth" ||
				account.account_uuid !== details.reconnect.accountUuid ||
				account.organization_uuid !== details.reconnect.organizationUuid ||
				account.account_uuid !== seat.identity.accountUuid ||
				(account.organization_uuid &&
					account.organization_uuid !== seat.identity.organizationUuid)
			)
				throw new EnrollmentError(
					409,
					"This is not the saved Claude account, or the seat has changed. Ask the operator to check it.",
				);
			return account;
		}
		if (
			this.context.dbOps.getAccountByName(details.name) ||
			this.context.dbOps
				.getAccountsByProvider("claude-code")
				.some((account) => account.account_uuid === seat.identity.accountUuid)
		)
			throw new EnrollmentError(
				409,
				"This seat is already connected. Ask the operator for help.",
			);
		return null;
	}
	private connectionStatus(
		provider: "claude-code",
		accountId: string,
	): {
		paused: boolean;
		inPool: boolean;
	} {
		const account = this.context.dbOps.getAccount(accountId);
		return {
			paused: account?.paused ?? false,
			inPool:
				!!account?.account_uuid &&
				this.context.config
					.getTeamRouting(provider)
					.allowlistedAccountUuids.includes(account.account_uuid),
		};
	}
	private save(details: Details, seat: VerifiedClaudeSeat): string {
		const { dbOps, config } = this.context;
		// No await inside: a failed config write rolls back the SQLite account/contact.
		return dbOps.getDatabase().transaction(() => {
			const existing = this.assertSeat(details, seat);
			if (existing) {
				dbOps.updateAccountTokens(
					existing.id,
					seat.tokens.accessToken,
					seat.tokens.expiresAt ?? null,
					seat.tokens.refreshToken ?? undefined,
				);
				if (
					[
						"OAuth refresh was rejected by the upstream",
						"missing OAuth refresh token",
					].includes(existing.error_reason ?? "")
				)
					dbOps.resumeAccount(existing.id);
				// A previous browser must not be able to disconnect this new authorization.
				for (const [key, entry] of this.entries)
					if (
						entry.state.kind === "connected" &&
						entry.state.accountId === existing.id
					)
						this.entries.delete(key);
				return existing.id;
			}
			const account = dbOps.createOAuthAccount({
				name: details.name,
				provider: "claude-code",
				...seat.tokens,
				accountUuid: seat.identity.accountUuid,
				organizationUuid: seat.identity.organizationUuid,
			});
			dbOps.setEnrollmentContact(account.id, {
				email: details.contactEmail,
				slackUserId: details.slackUserId,
			});
			config.allowAccountUuid("claude-code", seat.identity.accountUuid);
			return account.id;
		})();
	}

	private remove(accountId: string, accountUuid: string): void {
		const { dbOps, config } = this.context;
		dbOps.getDatabase().transaction(() => {
			const account = dbOps.getAccount(accountId);
			if (
				!account ||
				account.provider !== "claude-code" ||
				account.account_uuid !== accountUuid
			)
				throw new EnrollmentError(
					410,
					"This seat has changed or was already removed. Ask the operator to check it.",
				);
			if (!dbOps.deleteAccount(accountId))
				throw new Error("Seat removal failed");
			config.removeAccountUuid("claude-code", accountUuid);
		})();
	}
}

async function readBody(req: Request): Promise<Record<string, unknown>> {
	if (
		req.headers.get("content-type")?.split(";")[0].trim() !== "application/json"
	)
		throw new EnrollmentError(415, "JSON required");
	const reader = req.body?.getReader();
	if (!reader) throw new EnrollmentError(400, "JSON object required");
	const chunks: Uint8Array[] = [];
	let size = 0;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => {
			void reader.cancel();
			reject(new EnrollmentError(408, "Request timed out"));
		}, 10_000);
	});
	try {
		for (;;) {
			const { value, done } = await Promise.race([reader.read(), timeout]);
			if (done) break;
			size += value.byteLength;
			if (size > 8192) {
				void reader.cancel();
				throw new EnrollmentError(413, "Request too large");
			}
			chunks.push(value);
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
		} catch {
			throw new EnrollmentError(400, "Invalid JSON");
		}
		if (!isRecord(parsed))
			throw new EnrollmentError(400, "JSON object required");
		return parsed;
	} finally {
		clearTimeout(timer);
		reader.releaseLock();
	}
}
