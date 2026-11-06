import { afterEach, describe, expect, it } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Config } from "./index";

const tempDirs: string[] = [];

afterEach(() => {
	for (const directory of tempDirs.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

function configFrom(data: unknown): Config {
	const directory = mkdtempSync(join(tmpdir(), "agent-smith-alerts-"));
	tempDirs.push(directory);
	const path = join(directory, "config.json");
	writeFileSync(path, JSON.stringify(data));
	return new Config(path);
}

describe("alert configuration", () => {
	it("leaves a channel off when its value is blank, malformed or not https", () => {
		const config = configFrom({
			alerts: {
				slack_webhook_url: "http://hooks.slack.com/services/T/B/x",
				slack_bot_token: "",
				slack_channel: "  ",
				email: "not an email",
				email_from: "  ",
				resend_api_key: 42,
			},
		});

		expect(config.getAlerts()).toEqual({
			slackWebhookUrl: null,
			slackBotToken: null,
			slackChannel: null,
			email: null,
			emailFrom: null,
			resendApiKey: null,
		});
	});

	it("rewrites a readable config file 0600, since it holds alert credentials", () => {
		const directory = mkdtempSync(join(tmpdir(), "agent-smith-alerts-"));
		tempDirs.push(directory);
		const path = join(directory, "config.json");
		writeFileSync(path, JSON.stringify({ alerts: {} }), { mode: 0o644 });

		new Config(path).set("port", 8080);

		expect(statSync(path).mode & 0o777).toBe(0o600);
	});

	it("tightens a readable client config before using its forwarding-key file", () => {
		const directory = mkdtempSync(join(tmpdir(), "agent-smith-alerts-"));
		tempDirs.push(directory);
		const path = join(directory, "config.json");
		writeFileSync(
			path,
			JSON.stringify({
				client: {
					base_url: "http://127.0.0.1:18181",
					proxy_key_file: "/tmp/agent-smith.key",
				},
			}),
			{ mode: 0o644 },
		);

		new Config(path);

		expect(statSync(path).mode & 0o777).toBe(0o600);
	});

	it("creates the config directory 0700, since it holds client forwarding keys", () => {
		const directory = mkdtempSync(join(tmpdir(), "agent-smith-alerts-"));
		tempDirs.push(directory);
		const configDirectory = join(directory, "private");

		new Config(join(configDirectory, "config.json"));

		expect(statSync(configDirectory).mode & 0o777).toBe(0o700);
	});

	it("tightens an existing config directory before writing client forwarding keys", () => {
		const directory = mkdtempSync(join(tmpdir(), "agent-smith-alerts-"));
		tempDirs.push(directory);
		const configDirectory = join(directory, "private");
		mkdirSync(configDirectory, { mode: 0o755 });

		new Config(join(configDirectory, "config.json"));

		expect(statSync(configDirectory).mode & 0o777).toBe(0o700);
	});
});
