import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export type CodexCredentials = {
	accessToken?: string;
	accountId?: string;
	email?: string;
	planType?: string;
	refreshToken?: string;
};

type NativeCredentialOptions = {
	home?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function parseIdentity(
	idToken: unknown,
): Omit<CodexCredentials, "accessToken" | "refreshToken"> {
	if (typeof idToken !== "string") {
		return {};
	}

	try {
		const payload = idToken.split(".")[1];
		if (!payload) {
			return {};
		}
		const claims = JSON.parse(
			Buffer.from(payload, "base64url").toString("utf8"),
		) as unknown;
		if (!isRecord(claims)) {
			return {};
		}
		const authClaims = isRecord(claims["https://api.openai.com/auth"])
			? claims["https://api.openai.com/auth"]
			: undefined;
		const accountId = stringValue(authClaims?.chatgpt_account_id);
		const email = stringValue(claims.email);
		const planType = stringValue(authClaims?.chatgpt_plan_type);
		return {
			...(accountId && { accountId }),
			...(email && { email }),
			...(planType && { planType }),
		};
	} catch {
		return {};
	}
}

export function credentialsFromCodexTokenResponse(
	response: unknown,
): CodexCredentials {
	if (!isRecord(response)) {
		return {};
	}

	const identity = parseIdentity(response.id_token);
	const accessToken = stringValue(response.access_token);
	const refreshToken = stringValue(response.refresh_token);
	const accountId = stringValue(response.account_id);
	return {
		...(accessToken && { accessToken }),
		...(refreshToken && { refreshToken }),
		...(accountId && { accountId }),
		...identity,
	};
}

function expandHome(path: string, home: string): string {
	if (path === "~") {
		return home;
	}
	return path.startsWith("~/") ? join(home, path.slice(2)) : path;
}

export async function importCodexCredentials(
	path = "~/.codex/auth.json",
	options: NativeCredentialOptions = {},
): Promise<CodexCredentials> {
	const contents = await readFile(
		expandHome(path, options.home ?? homedir()),
		"utf8",
	);
	const parsed = JSON.parse(contents) as unknown;
	const tokens =
		isRecord(parsed) && isRecord(parsed.tokens) ? parsed.tokens : {};
	return credentialsFromCodexTokenResponse(tokens);
}
