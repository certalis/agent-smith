import type { ProviderBlockCategory } from "@agent-smith/capacity";

export const INTERACTIVE_PROVIDER_CHOICE_HEADER =
	"x-agent-smith-interactive-provider-choice";
export const PROVIDER_CHOICE_HEADER = "x-agent-smith-provider-choice";
export const PROVIDER_CHOICE_MENU_HEADER = "x-agent-smith-provider-menu";
export const PROVIDER_WAIT_HEADER = "x-agent-smith-provider-wait";
export const PROVIDER_PROMOTION_DECLINED_HEADER =
	"x-agent-smith-provider-promotion-declined";
export const PROVIDER_CAPACITY_HEADER = "x-agent-smith-provider-capacity";
export const PROVIDER_CAPACITY_DETAILS_HEADER =
	"x-agent-smith-provider-capacity-details";
export const PROVIDER_PROMOTION_DETAILS_HEADER =
	"x-agent-smith-provider-promotion-details";
export const SERVED_PROVIDER_HEADER = "x-agent-smith-served-provider";
export const SERVED_MODEL_HEADER = "x-agent-smith-served-model";

export type ProviderChoice = {
	model: string;
	provider: string;
};

type ChoiceProblemDetails = CapacityProblem & {
	kind: "capacity" | "manual";
};

type CapacityProblem = {
	blockedProvider: string;
	category: ProviderBlockCategory;
	choices: readonly ProviderChoice[];
	retryAt?: number;
};

function encodeCapacityDetails(problem: ChoiceProblemDetails): string {
	return Buffer.from(
		JSON.stringify({
			kind: problem.kind,
			blockedProvider: problem.blockedProvider,
			category: problem.category,
			choices: problem.choices,
			wait: problem.retryAt === undefined ? null : { retryAt: problem.retryAt },
		}),
	).toString("base64url");
}

export function interactiveProviderChoiceRequested(headers: Headers): boolean {
	return headers.get(INTERACTIVE_PROVIDER_CHOICE_HEADER) === "v1";
}

export function manualProviderChoiceRequested(headers: Headers): boolean {
	return headers.get(PROVIDER_CHOICE_MENU_HEADER) === "v1";
}

export function providerWaitRequested(headers: Headers): boolean {
	return headers.get(PROVIDER_WAIT_HEADER) === "v1";
}

export function capacityChoices(
	candidates: readonly ProviderChoice[],
	blockedProvider: string,
	eligibleProviders: ReadonlySet<string>,
): ProviderChoice[] {
	return candidates.filter(
		(candidate) =>
			candidate.provider !== blockedProvider &&
			eligibleProviders.has(candidate.provider),
	);
}

export function readProviderChoice(
	headers: Headers,
	choices: readonly ProviderChoice[],
): string | null {
	const selected = headers.get(PROVIDER_CHOICE_HEADER);
	return selected && choices.some((choice) => choice.provider === selected)
		? selected
		: null;
}

export function providerPromotionDeclined(headers: Headers): boolean {
	return headers.get(PROVIDER_PROMOTION_DECLINED_HEADER) === "v1";
}

export function stripProviderChoiceHeaders(headers: Headers): Headers {
	const forwarded = new Headers(headers);
	forwarded.delete(INTERACTIVE_PROVIDER_CHOICE_HEADER);
	forwarded.delete(PROVIDER_CHOICE_HEADER);
	forwarded.delete(PROVIDER_CHOICE_MENU_HEADER);
	forwarded.delete(PROVIDER_WAIT_HEADER);
	forwarded.delete(PROVIDER_PROMOTION_DECLINED_HEADER);
	return forwarded;
}

/** Adds only factual served-provider metadata after a pool request succeeds. */
export function withServedProviderHeaders(
	response: Response,
	choice: ProviderChoice,
): Response {
	const headers = new Headers(response.headers);
	headers.set(SERVED_PROVIDER_HEADER, choice.provider);
	headers.set(SERVED_MODEL_HEADER, choice.model);
	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers,
	});
}

/** Adds eligible higher-ranked options without claiming upstream health. */
export function withProviderPromotionDetails(
	response: Response,
	choices: readonly ProviderChoice[],
): Response {
	if (choices.length === 0) return response;
	const headers = new Headers(response.headers);
	headers.set(
		PROVIDER_PROMOTION_DETAILS_HEADER,
		Buffer.from(JSON.stringify({ choices })).toString("base64url"),
	);
	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers,
	});
}

export function createProviderCapacityProblem({
	blockedProvider,
	category,
	choices,
	retryAt,
}: CapacityProblem): Response {
	const retryAfter =
		retryAt === undefined
			? undefined
			: String(Math.max(1, Math.ceil((retryAt - Date.now()) / 1000)));
	return Response.json(
		{
			type: "urn:agent-smith:provider-capacity:v1",
			title: "Current provider cannot serve this turn",
			status: 429,
			blockedProvider,
			category,
			choices,
			wait: retryAt === undefined ? null : { retryAt },
		},
		{
			status: 429,
			headers: {
				"cache-control": "no-store",
				"content-type": "application/problem+json",
				"x-should-retry": "false",
				...(retryAfter ? { "retry-after": retryAfter } : {}),
				[PROVIDER_CAPACITY_HEADER]: "v1",
				[PROVIDER_CAPACITY_DETAILS_HEADER]: encodeCapacityDetails({
					kind: "capacity",
					blockedProvider,
					category,
					choices,
					retryAt,
				}),
			},
		},
	);
}

/** A private interactive menu request; this is not a provider failure. */
export function createProviderChoiceProblem({
	activeProvider,
	choices,
}: {
	activeProvider: string;
	choices: readonly ProviderChoice[];
}): Response {
	return Response.json(
		{
			type: "urn:agent-smith:provider-choice:v1",
			title: "Choose provider for this conversation",
			status: 409,
			activeProvider,
			choices,
			wait: null,
		},
		{
			status: 409,
			headers: {
				"cache-control": "no-store",
				"content-type": "application/problem+json",
				"x-should-retry": "false",
				[PROVIDER_CAPACITY_HEADER]: "v1",
				[PROVIDER_CAPACITY_DETAILS_HEADER]: encodeCapacityDetails({
					kind: "manual",
					blockedProvider: activeProvider,
					category: "unknown",
					choices,
				}),
			},
		},
	);
}
