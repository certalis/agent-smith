import { expect, it, spyOn } from "bun:test";
import { Logger } from "@agent-smith/logger";
import { waitForProxyBackgroundTasks } from "./background-tasks";
import { SeatAlerts } from "./seat-alerts";

it("never logs the webhook URL when a send fails", async () => {
	const warn = spyOn(Logger.prototype, "warn");
	const alerts = new SeatAlerts(
		{
			slackWebhookUrl: "https://hooks.slack.com/services/T/B/secret",
			slackBotToken: null,
			slackChannel: null,
			email: null,
			emailFrom: null,
			resendApiKey: null,
		},
		async (url) => {
			throw new TypeError(`fetch failed for ${url}`);
		},
	);

	alerts.extraUsageSpent({ name: "seat-a", quota_state: null }, "claude-code");
	await waitForProxyBackgroundTasks();

	const logged = warn.mock.calls.map(([message]) => message);
	warn.mockRestore();
	expect(logged).toContain("Slack alert could not be sent (TypeError)");
	expect(logged.join("\n")).not.toContain("secret");
});
