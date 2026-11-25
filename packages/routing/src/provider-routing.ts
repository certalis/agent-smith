import { createHash } from "node:crypto";

type TeamRoutingRequest = {
	sessionId: string | null;
	manualAccountName?: string;
	pinScope?: string;
	provider: string;
};
type TeamRoutingConfig = {
	enabled: boolean;
	callerProviderFallback: Record<string, string>;
};
type RouterFallbackConfig = {
	callers: Record<string, { allowFallbacks: boolean }>;
};

export function providerConversationKey(
	request: TeamRoutingRequest,
): string | null {
	if (!request.sessionId) return null;
	return createHash("sha256")
		.update(
			[request.pinScope ?? request.provider, request.sessionId].join("\u0000"),
		)
		.digest("hex");
}

/** Only a registered device the private policy names may move on to later pool providers. */
export function hasOrderedProviderFallback(
	config: TeamRoutingConfig | RouterFallbackConfig,
	callerId: string | undefined,
): boolean {
	if ("callers" in config)
		return (
			callerId !== undefined &&
			Object.hasOwn(config.callers, callerId) &&
			config.callers[callerId]?.allowFallbacks === true
		);
	return (
		config.enabled &&
		callerId !== undefined &&
		Object.hasOwn(config.callerProviderFallback, callerId) &&
		config.callerProviderFallback[callerId] === "ordered"
	);
}

export function getConversationProviderKey(
	request: TeamRoutingRequest | undefined,
): string | undefined {
	if (!request?.sessionId || request.manualAccountName) return undefined;
	return providerConversationKey(request) ?? undefined;
}
