import {
	choosePromotion,
	isAnthropicPoolRequest,
	retryCapacityBlockedRequest,
} from "./provider-choice.js";

export function register(on) {
	let promotion = null;
	let promotionDecision = null;
	let promotionReadyAfterTurn = 0;
	let completedMainTurns = 0;
	let openChoiceMenu = false;
	const providerChoiceDecisions = new Map();
	on("session.start", async ($, event, next) => {
		await $.command.register({
			name: "agent-smith-provider",
			description: "Choose a provider for this conversation",
		});
		return await next(event);
	});
	on("command.run", { command: "agent-smith-provider" }, ($) => {
		openChoiceMenu = true;
		$.ui.status("Agent-smith: choose a provider on your next turn.");
		return {
			isTextDisplayOnly: true,
			text: "Agent-smith: send your next message to choose a provider.",
		};
	});
	on("turn.complete", async (_$, event, next) => {
		if (!event.agentId) completedMainTurns += 1;
		return await next(event);
	});
	on("http.fetch", async ($, event, next) => {
		if (!isAnthropicPoolRequest(event.url)) return next(event);
		let initialChoice;
		const chooseNow = openChoiceMenu;
		openChoiceMenu = false;
		let declinePromotion = false;
		if (
			promotionDecision ||
			(promotion && completedMainTurns >= promotionReadyAfterTurn)
		) {
			promotionDecision ??= choosePromotion(promotion, (question, options) =>
				$.ui.ask(question, { header: "Agent-smith", options }),
			)
				.then((choice) => choice?.provider)
				.catch(() => undefined);
			initialChoice = await promotionDecision;
			declinePromotion = !initialChoice;
			promotion = null;
			promotionDecision = null;
		}
		return await retryCapacityBlockedRequest({
			init: event.init,
			initialChoice,
			declinePromotion,
			openChoiceMenu: chooseNow,
			ask: (question, options) => {
				const key = JSON.stringify([question, options]);
				const existing = providerChoiceDecisions.get(key);
				if (existing) return existing;
				const decision = $.ui
					.ask(question, { header: "Agent-smith", options })
					.finally(() => providerChoiceDecisions.delete(key));
				providerChoiceDecisions.set(key, decision);
				return decision;
			},
			setStatus: (status) => $.ui.status(status),
			onPromotion: (choices) => {
				if (promotion) return;
				promotion = choices;
				promotionReadyAfterTurn = completedMainTurns + 1;
			},
			send: async (init) => await next({ ...event, init }),
		});
	});
}
