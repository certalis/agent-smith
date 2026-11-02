import { CLAUDE_CODE_OAUTH_TOKEN_URL } from "@ccflare/providers";

const PROXY_ONLY_HEADERS = [
	"host",
	"content-length",
	"x-api-key",
	"x-ccflare-scenario-client-id",
] as const;

/**
 * Claude Code refreshes through its configured base URL. This endpoint is a
 * client credential exchange, not a pooled inference request, so it bypasses
 * account selection and never forwards the proxy authentication key.
 */
export async function forwardOAuthTokenRequest(
	req: Request,
	body: ArrayBuffer | null,
): Promise<Response> {
	const headers = new Headers(req.headers);
	for (const header of PROXY_ONLY_HEADERS) {
		headers.delete(header);
	}

	return await fetch(CLAUDE_CODE_OAUTH_TOKEN_URL, {
		method: req.method,
		headers,
		body: body ? new Response(body).body : undefined,
		...(body ? ({ duplex: "half" } as RequestInit) : {}),
	});
}
