import { createHash } from "node:crypto";
import type { TeamRoutingConfig } from "@agent-smith/config";
import type { TeamRoutingRequest } from "@agent-smith/pool";

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
	config: TeamRoutingConfig,
	callerId: string | undefined,
): boolean {
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
