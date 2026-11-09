import type { AlertsConfig } from "@agent-smith/config";
import { Logger } from "@agent-smith/logger";
import type { Account, RequestMeta } from "@agent-smith/types";
import { trackProxyBackgroundTask } from "./background-tasks";
import {
	getSoonestQuotaReset,
	isEveryAccountQuotaBlocked,
} from "./handlers/account-selector";
import type { ResolvedProxyContext } from "./handlers/proxy-types";

const log = new Logger("SeatAlerts");
const RESEND_EMAILS_URL = "https://api.resend.com/emails";
const SLACK_POST_MESSAGE_URL = "https://slack.com/api/chat.postMessage";
const SEND_TIMEOUT_MS = 10_000;
const SLACK_ERROR_CODE = /^[a-z_]{1,64}$/;

type Alert = { subject: string; text: string };

type Send = (url: string, init: RequestInit) => Promise<Response>;

/** What a full fleet does with requests, so the alert says it truthfully. */
type FullFleetPolicy = { blocked: boolean; holdSeconds: number };

type Delivery = {
	channel: "email" | "Slack";
	url: string;
	headers?: Record<string, string>;
	body: unknown;
	/** Slack's Web API answers HTTP 200 with `ok: false` when it refuses a message. */
	repliesOk?: boolean;
};

type SlackReply = { ok?: unknown; error?: unknown };

/** The fleet-full trigger HTTP and WebSocket share; the pool route checks each of its providers itself. */
export function alertWhenFleetFull(
	meta: RequestMeta,
	ctx: ResolvedProxyContext,
	holdSeconds: number,
): void {
	const resetAt = getSoonestQuotaReset(meta, ctx);
	if (resetAt === null || !isEveryAccountQuotaBlocked(meta, ctx)) return;
	ctx.seatAlerts?.allAccountsFull(ctx.providerName, resetAt, {
		blocked: ctx.runtime.blockWhenAllFull,
		holdSeconds,
	});
}

function utc(at: number): string {
	return `${new Date(at).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/**
 * Tells the operator when a seat spends extra usage or the whole fleet is
 * full. Messages carry account names, never tokens, ids or prompt content.
 */
export class SeatAlerts {
	private readonly fullUntil = new Map<string, number>();

	constructor(
		private readonly config: AlertsConfig,
		private readonly send: Send = (url, init) => fetch(url, init),
	) {
		if (config.email && !(config.emailFrom && config.resendApiKey)) {
			log.warn(
				"alerts.email is set without alerts.email_from and alerts.resend_api_key: email alerts are off",
			);
		}
		if (!config.slackBotToken !== !config.slackChannel) {
			log.warn(
				"alerts.slack_bot_token and alerts.slack_channel go together: Slack bot alerts are off",
			);
		}
	}

	/** Called once per served response that the provider billed to extra usage. */
	extraUsageSpent(
		account: Pick<Account, "name" | "quota_state">,
		provider: string,
	): void {
		const claim = account.quota_state?.representativeClaim;
		const resetAt = account.quota_state?.windows.unified?.resetAt;
		this.notify({
			subject: `agent-smith: ${account.name} spent extra usage`,
			text: `${account.name} (${provider}) is past its plan limit${claim ? ` (${claim})` : ""} and a response it just served was billed to extra usage.${resetAt ? ` The limit resets at ${utc(resetAt)}.` : ""}`,
		});
	}

	/** Called on every refused request; alerts once until the soonest reset passes. */
	allAccountsFull(
		scope: string,
		resetAt: number,
		policy: FullFleetPolicy,
	): void {
		if ((this.fullUntil.get(scope) ?? 0) > Date.now()) return;
		this.fullUntil.set(scope, resetAt);
		const probe = policy.blocked
			? ""
			: ", except one a minute that revalidates and may spend extra usage";
		const hold =
			policy.holdSeconds > 0
				? `; one within ${policy.holdSeconds}s of the reset waits for it instead`
				: "";
		this.notify({
			subject: `agent-smith: every ${scope} account is full`,
			text: `Every ${scope} account is out of quota until ${utc(resetAt)}. Requests are refused until then${probe}${hold}.`,
		});
	}

	private notify(alert: Alert): void {
		log.warn(alert.text);
		for (const delivery of this.deliveries(alert)) {
			trackProxyBackgroundTask(this.deliver(delivery));
		}
	}

	private deliveries(alert: Alert): Delivery[] {
		const {
			email,
			emailFrom,
			resendApiKey,
			slackBotToken,
			slackChannel,
			slackWebhookUrl,
		} = this.config;
		const deliveries: Delivery[] = [];
		if (slackWebhookUrl) {
			deliveries.push({
				channel: "Slack",
				url: slackWebhookUrl,
				body: { text: alert.text },
			});
		}
		if (slackBotToken && slackChannel) {
			deliveries.push({
				channel: "Slack",
				url: SLACK_POST_MESSAGE_URL,
				headers: { authorization: `Bearer ${slackBotToken}` },
				body: { channel: slackChannel, text: alert.text },
				repliesOk: true,
			});
		}
		if (email && emailFrom && resendApiKey) {
			deliveries.push({
				channel: "email",
				url: RESEND_EMAILS_URL,
				headers: { authorization: `Bearer ${resendApiKey}` },
				body: {
					from: emailFrom,
					to: [email],
					subject: alert.subject,
					text: alert.text,
				},
			});
		}
		return deliveries;
	}

	private async deliver(delivery: Delivery): Promise<void> {
		try {
			const response = await this.send(delivery.url, {
				method: "POST",
				headers: { "content-type": "application/json", ...delivery.headers },
				body: JSON.stringify(delivery.body),
				signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
			});
			if (!response.ok) {
				log.warn(
					`${delivery.channel} alert was refused with HTTP ${response.status}`,
				);
				return;
			}
			if (!delivery.repliesOk) return;
			const reply = (await response.json()) as SlackReply;
			if (reply.ok !== true) {
				const code =
					typeof reply.error === "string" && SLACK_ERROR_CODE.test(reply.error)
						? reply.error
						: "no reason given";
				log.warn(`${delivery.channel} alert was refused (${code})`);
			}
		} catch (error) {
			// The error text can echo the webhook URL, which is a credential.
			log.warn(
				`${delivery.channel} alert could not be sent (${error instanceof Error ? error.name : "unknown error"})`,
			);
		}
	}
}
