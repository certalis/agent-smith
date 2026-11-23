import {
	choosePromotion,
	isAnthropicPoolRequest,
	retryCapacityBlockedRequest,
} from "./provider-choice.js";

export function register(on) {
	let promotion = null;
	let openChoiceMenu = false;
	on("session.start", async ($, event, next) => {
		await $.command.register({
			name: "agent-smith-provider",
			description: "Choose a provider for your next turn",
		});
		return await next(event);
	});
	on("command.run", { command: "agent-smith-provider" }, ($) => {
		openChoiceMenu = true;
		$.ui.status("Agent-smith: choose a provider on your next turn.");
		return { isTextDisplayOnly: true };
	});
	on("http.fetch", async ($, event, next) => {
		if (!isAnthropicPoolRequest(event.url)) return next(event);
		let initialChoice;
		const chooseNow = openChoiceMenu;
		openChoiceMenu = false;
		let declinePromotion = false;
		if (promotion) {
			try {
				const choice = await choosePromotion(promotion, (question, options) =>
					$.ui.ask(question, { header: "Agent-smith", options }),
				);
				initialChoice = choice?.provider;
				declinePromotion = !initialChoice;
			} catch {
				declinePromotion = true;
			}
			promotion = null;
		}
		return await retryCapacityBlockedRequest({
			init: event.init,
			initialChoice,
			declinePromotion,
			openChoiceMenu: chooseNow,
			ask: (question, options) =>
				$.ui.ask(question, { header: "Agent-smith", options }),
			setStatus: (status) => $.ui.status(status),
			onPromotion: (choices) => {
				promotion = choices;
			},
			send: async (init) => await next({ ...event, init }),
		});
	});
}
