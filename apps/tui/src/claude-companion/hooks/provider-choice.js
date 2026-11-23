const CAPACITY_HEADER = "x-agent-smith-provider-capacity";
const CAPACITY_DETAILS_HEADER = "x-agent-smith-provider-capacity-details";
const INTERACTIVE_CHOICE_HEADER = "x-agent-smith-interactive-provider-choice";
const PROVIDER_CHOICE_HEADER = "x-agent-smith-provider-choice";
const PROVIDER_CHOICE_MENU_HEADER = "x-agent-smith-provider-menu";
const PROVIDER_WAIT_HEADER = "x-agent-smith-provider-wait";
const PROMOTION_DECLINED_HEADER = "x-agent-smith-provider-promotion-declined";
const PROMOTION_DETAILS_HEADER = "x-agent-smith-provider-promotion-details";
const SERVED_PROVIDER_HEADER = "x-agent-smith-served-provider";
const SERVED_MODEL_HEADER = "x-agent-smith-served-model";
const WAIT = "Wait";

const CATEGORIES = new Set([
	"request-rate",
	"token-allocation",
	"burst",
	"dynamic-throughput",
	"temporary-capacity",
	"unknown",
]);

function headerValue(headers, name) {
	if (headers && typeof headers.get === "function") return headers.get(name);
	if (!headers || typeof headers !== "object") return null;
	const found = Object.entries(headers).find(
		([key]) => key.toLowerCase() === name,
	);
	return typeof found?.[1] === "string" ? found[1] : null;
}

export function classifyCapacityResponse(status, headers) {
	return (
		(status === 409 || status === 429) &&
		headerValue(headers, CAPACITY_HEADER) === "v1"
	);
}

function isChoice(value) {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof value.provider === "string" &&
		value.provider.length > 0 &&
		typeof value.model === "string" &&
		value.model.length > 0
	);
}

function isWait(value) {
	return (
		value === null ||
		(typeof value === "object" &&
			value !== null &&
			Number.isSafeInteger(value.retryAt) &&
			value.retryAt > 0)
	);
}

function decodeHeaderJson(headers, name) {
	const encoded = headerValue(headers, name);
	if (!encoded || encoded.length > 16_384) return null;
	try {
		const base64 = encoded.replaceAll("-", "+").replaceAll("_", "/");
		const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
		return JSON.parse(
			new TextDecoder().decode(
				Uint8Array.from(atob(padded), (character) => character.charCodeAt(0)),
			),
		);
	} catch {
		return null;
	}
}

export function readCapacityDetails(headers) {
	const value = decodeHeaderJson(headers, CAPACITY_DETAILS_HEADER);
	try {
		if (
			typeof value !== "object" ||
			value === null ||
			typeof value.blockedProvider !== "string" ||
			value.blockedProvider.length === 0 ||
			typeof value.category !== "string" ||
			!CATEGORIES.has(value.category) ||
			!Array.isArray(value.choices) ||
			!value.choices.every(isChoice) ||
			!isWait(value.wait)
		) {
			return null;
		}
		if (
			value.kind !== undefined &&
			value.kind !== "capacity" &&
			value.kind !== "manual"
		) {
			return null;
		}
		return value;
	} catch {
		return null;
	}
}

export function readPromotionDetails(headers) {
	const value = decodeHeaderJson(headers, PROMOTION_DETAILS_HEADER);
	return typeof value === "object" &&
		value !== null &&
		Array.isArray(value.choices) &&
		value.choices.length > 0 &&
		value.choices.every(isChoice)
		? value
		: null;
}

function withoutHeader(headers, name) {
	return Object.fromEntries(
		Object.entries(headers ?? {}).filter(([key]) => key.toLowerCase() !== name),
	);
}

function choiceHeaders(
	init,
	provider,
	declinePromotion = false,
	openChoiceMenu = false,
	waitForProvider = false,
) {
	const headers = withoutHeader(
		withoutHeader(
			withoutHeader(init?.headers, PROVIDER_CHOICE_HEADER),
			PROVIDER_CHOICE_MENU_HEADER,
		),
		PROMOTION_DECLINED_HEADER,
	);
	headers[INTERACTIVE_CHOICE_HEADER] = "v1";
	if (provider) headers[PROVIDER_CHOICE_HEADER] = provider;
	if (declinePromotion) headers[PROMOTION_DECLINED_HEADER] = "v1";
	if (openChoiceMenu) headers[PROVIDER_CHOICE_MENU_HEADER] = "v1";
	if (waitForProvider) headers[PROVIDER_WAIT_HEADER] = "v1";
	return { ...init, headers };
}

function displayProvider(provider) {
	return provider
		.replace(/-claude$/, "")
		.split(/[-_]/)
		.filter(Boolean)
		.map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
		.join(" ");
}

function choiceLabel(choice) {
	return `${displayProvider(choice.provider)} · ${choice.model}`;
}

function categoryLabel(category) {
	return (
		{
			"request-rate": "request rate",
			"token-allocation": "token allocation",
			burst: "traffic burst",
			"dynamic-throughput": "temporary provider capacity",
			"temporary-capacity": "temporary provider capacity",
			unknown: "an unknown provider limit",
		}[category] ?? "an unknown provider limit"
	);
}

function servedStatus(response) {
	const provider = headerValue(response.headers, SERVED_PROVIDER_HEADER);
	const model = headerValue(response.headers, SERVED_MODEL_HEADER);
	return provider && model ? `Agent-smith: ${provider} · ${model}` : null;
}

async function chooseProvider(details, ask) {
	return await chooseChoices(
		details.kind === "manual"
			? "Choose provider for this turn."
			: `${displayProvider(details.blockedProvider)} cannot serve this turn because of ${categoryLabel(details.category)}. Switch provider?`,
		details.choices,
		ask,
	);
}

async function chooseChoices(question, choices, ask) {
	let start = 0;
	while (start < choices.length) {
		const remaining = choices.length - start;
		const take = remaining > 3 ? 2 : 3;
		const page = choices.slice(start, start + take);
		const hasMore = start + page.length < choices.length;
		const labels = page.map(choiceLabel);
		const answer = await ask(question, [
			...labels,
			...(hasMore ? ["More providers"] : []),
			WAIT,
		]);
		if (answer === WAIT) return null;
		if (answer === "More providers" && hasMore) {
			start += page.length;
			continue;
		}
		const choice = page.find((candidate) => choiceLabel(candidate) === answer);
		if (choice) return choice;
		return null;
	}
	return null;
}

export async function choosePromotion(choices, ask) {
	return await chooseChoices(
		"A higher-ranked provider has an eligible Agent-smith account. Switch provider for this turn?",
		choices,
		ask,
	);
}

/**
 * The transport-neutral core of the Claude Code hook. It starts every eligible
 * pool request in interactive mode, asks only after a versioned capacity
 * response, then sends the unchanged request once more with the chosen provider.
 */
export async function retryCapacityBlockedRequest({
	init,
	send,
	ask,
	setStatus,
	initialChoice,
	declinePromotion = false,
	openChoiceMenu = false,
	onPromotion,
}) {
	let response = await send(
		choiceHeaders(init, initialChoice, declinePromotion, openChoiceMenu),
	);
	const initialStatus = servedStatus(response);
	if (initialStatus) setStatus(initialStatus);
	if (!classifyCapacityResponse(response.status, response.headers)) {
		const promotion = response.ok
			? readPromotionDetails(response.headers)
			: null;
		if (promotion) onPromotion?.(promotion.choices);
		return response;
	}

	const details = readCapacityDetails(response.headers);
	if (!details) return response;
	if (details.choices.length === 0) {
		return details.kind === "manual"
			? await send(choiceHeaders(init))
			: response;
	}
	const choice = await chooseProvider(details, ask);
	if (!choice && details.kind !== "manual" && details.wait === null) {
		setStatus(
			"Agent-smith: the provider supplied no retry time, so this turn remains on its current provider.",
		);
		return response;
	}
	response = await send(
		choiceHeaders(
			init,
			choice?.provider,
			false,
			false,
			!choice && details.kind !== "manual",
		),
	);
	const status = servedStatus(response);
	if (status) setStatus(status);
	if (!choice) {
		const waitResult = readCapacityDetails(response.headers);
		if (waitResult) {
			setStatus(
				"Agent-smith: it cannot hold this request until the provider retry time, so this turn remains blocked.",
			);
		}
	}
	return response;
}

export function isAnthropicPoolRequest(url) {
	try {
		return new URL(url).pathname.startsWith("/v1/pool/anthropic-messages/");
	} catch {
		return false;
	}
}
