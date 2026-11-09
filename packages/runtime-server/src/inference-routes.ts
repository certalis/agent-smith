const INFERENCE_ROUTES = new Set([
	"POST /v1/claude-code/v1/messages",
	"POST /v1/claude-code/v1/messages/count_tokens",
	"POST /v1/pool/anthropic-messages/v1/messages",
	"POST /v1/pool/anthropic-messages/v1/messages/count_tokens",
	"POST /v1/codex/responses",
	"POST /v1/pool/openai-responses/responses",
]);

for (const route of [...INFERENCE_ROUTES]) {
	if (route.endsWith("/messages") || route.endsWith("/count_tokens")) {
		INFERENCE_ROUTES.add(`${route}?beta=true`);
	}
}

export function isInferenceRoute(method: string, path: string): boolean {
	return INFERENCE_ROUTES.has(`${method} ${path}`);
}

export function isDeviceRoute(method: string, path: string): boolean {
	return (
		(method === "GET" && path === "/health") || isInferenceRoute(method, path)
	);
}
