import { EventEmitter } from "node:events";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import {
	DEFAULT_STRATEGY,
	isValidStrategy,
	NETWORK,
	patterns,
	TIME_CONSTANTS,
	ValidationError,
} from "@ccflare/core";
import { Logger } from "@ccflare/logger";
import {
	isFiniteNumber,
	isLbStrategy,
	isProviderWire,
	isRecord,
	PROVIDER_WIRES,
	type ProviderWire,
	type StrategyName,
} from "@ccflare/types";
import { resolveConfigPath } from "./paths";

const log = new Logger("Config");

export interface RuntimeConfig {
	blockWhenAllFull: boolean;
	clientId: string;
	maxBodyBytes: number;
	quotaThreshold: number;
	requestScopedRetryDelayMs: number;
	retry: { attempts: number; delayMs: number; backoff: number };
	sessionDurationMs: number;
	port: number;
	teamRouting: TeamRoutingConfig;
}

export interface TeamRoutingConfig {
	enabled: boolean;
	distributionEnabled: boolean;
	allowlistedAccountUuids: string[];
	maxUsage: number;
	admissionCap: number;
	admissionQueueLimit: number;
	admissionWaitMs: number;
	holdSeconds: number;
	quotaProbeSeconds: number;
}

export type TeamRoutingFileConfig = {
	enabled?: boolean;
	distribution_enabled?: boolean;
	allowlisted_account_uuids?: string[];
	max_usage?: number;
	admission_cap?: number;
	admission_queue_limit?: number;
	admission_wait_ms?: number;
	hold_seconds?: number;
	quota_probe_seconds?: number;
};

/** Where seat alerts go; a channel with an empty value stays off. */
export interface AlertsConfig {
	slackWebhookUrl: string | null;
	slackBotToken: string | null;
	slackChannel: string | null;
	email: string | null;
	emailFrom: string | null;
	resendApiKey: string | null;
}

export type AlertsFileConfig = {
	slack_webhook_url?: string;
	slack_bot_token?: string;
	slack_channel?: string;
	email?: string;
	email_from?: string;
	resend_api_key?: string;
};

export const PROVIDER_STRATEGIES = [
	"anthropic-api",
	"openai-api",
	"claude-code",
	"codex",
] as const;

export type ProviderStrategy = (typeof PROVIDER_STRATEGIES)[number];

export type ProviderFileConfig = {
	enabled?: boolean;
	strategy?: ProviderStrategy;
	base_url?: string;
	models?: Record<string, string>;
};

export type ProviderConfig = {
	name: string;
	enabled: boolean;
	strategy: ProviderStrategy;
	baseUrl?: string;
	models?: Record<string, string>;
};

export type ProviderPoolsFileConfig = Partial<Record<ProviderWire, string[]>>;

/** How locally installed Claude Code and Codex reach this Agent-smith server. */
export type ClientRoutingFileConfig = {
	enabled?: boolean;
	base_url?: string;
	proxy_key_file?: string;
};

export type ClientRoutingConfig = {
	enabled: boolean;
	baseUrl?: string;
	proxyKeyFile?: string;
};

const BUILTIN_PROVIDER_CONFIGS: readonly ProviderConfig[] = [
	{ name: "anthropic", enabled: true, strategy: "anthropic-api" },
	{ name: "openai", enabled: true, strategy: "openai-api" },
	{ name: "claude-code", enabled: false, strategy: "claude-code" },
	{ name: "codex", enabled: false, strategy: "codex" },
] as const;

const BUILTIN_PROVIDER_CONFIG_BY_NAME = new Map(
	BUILTIN_PROVIDER_CONFIGS.map((provider) => [provider.name, provider]),
);
const PROVIDER_NAME_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;

const TEAM_ROUTING_DEFAULTS: TeamRoutingConfig = {
	enabled: false,
	distributionEnabled: true,
	allowlistedAccountUuids: [],
	maxUsage: 0.9,
	admissionCap: 5,
	admissionQueueLimit: 25,
	admissionWaitMs: 30_000,
	holdSeconds: 0,
	quotaProbeSeconds: 0,
};

export interface ConfigData {
	lb_strategy?: StrategyName;
	client_id?: string;
	max_body_bytes?: number;
	quota_threshold?: number;
	retry_attempts?: number;
	retry_delay_ms?: number;
	retry_backoff?: number;
	request_scoped_429_retry_delay_ms?: number;
	session_duration_ms?: number;
	port?: number;
	data_retention_days?: number;
	request_retention_days?: number;
	team_routing?: TeamRoutingFileConfig;
	providers?: Record<string, ProviderFileConfig>;
	provider_pools?: ProviderPoolsFileConfig;
	client?: ClientRoutingFileConfig;
	enrollment_emails?: string[];
	alerts?: AlertsFileConfig;
	block_when_all_full?: boolean;
	[key: string]:
		| string
		| number
		| boolean
		| string[]
		| TeamRoutingFileConfig
		| Record<string, ProviderFileConfig>
		| ProviderPoolsFileConfig
		| ClientRoutingFileConfig
		| AlertsFileConfig
		| undefined;
}

function parseNumber(value: string | undefined): number | undefined {
	if (value === undefined) {
		return undefined;
	}

	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : undefined;
}

const MAX_ENROLLMENT_EMAILS = 200;

function normalizeEnrollmentEmail(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const email = value.trim().toLowerCase();
	return email.length <= 254 && patterns.email.test(email) ? email : undefined;
}

function sanitizeEnrollmentEmails(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const emails = value
		.map(normalizeEnrollmentEmail)
		.filter((email): email is string => email !== undefined);
	return [...new Set(emails)].slice(0, MAX_ENROLLMENT_EMAILS);
}

function sanitizeConfigData(value: unknown): ConfigData {
	if (!isRecord(value)) {
		return {};
	}

	const sanitized: ConfigData = {};

	for (const [key, entry] of Object.entries(value)) {
		if (key === "enrollment_emails") {
			const emails = sanitizeEnrollmentEmails(entry);
			if (emails) sanitized.enrollment_emails = emails;
			continue;
		}
		if (key === "team_routing") {
			const teamRouting = sanitizeTeamRouting(entry);
			if (teamRouting) sanitized.team_routing = teamRouting;
			continue;
		}
		if (key === "providers") {
			const providers = sanitizeProviderConfigs(entry);
			if (providers) sanitized.providers = providers;
			continue;
		}
		if (key === "provider_pools") {
			const providerPools = sanitizeProviderPools(entry);
			if (providerPools) sanitized.provider_pools = providerPools;
			continue;
		}
		if (key === "client") {
			const client = sanitizeClientRouting(entry);
			if (client) sanitized.client = client;
			continue;
		}
		if (key === "alerts") {
			const alerts = sanitizeAlerts(entry);
			if (alerts) sanitized.alerts = alerts;
			continue;
		}
		if (
			typeof entry === "string" ||
			typeof entry === "boolean" ||
			isFiniteNumber(entry)
		) {
			sanitized[key] = entry;
		}
	}

	if (!isLbStrategy(String(sanitized.lb_strategy ?? ""))) {
		delete sanitized.lb_strategy;
	}

	const numericKeys = [
		"retry_attempts",
		"max_body_bytes",
		"quota_threshold",
		"retry_delay_ms",
		"retry_backoff",
		"request_scoped_429_retry_delay_ms",
		"session_duration_ms",
		"port",
		"data_retention_days",
		"request_retention_days",
	] as const;

	for (const key of numericKeys) {
		const entry = sanitized[key];
		if (entry !== undefined && !isFiniteNumber(entry)) {
			delete sanitized[key];
		}
	}

	if (
		sanitized.client_id !== undefined &&
		typeof sanitized.client_id !== "string"
	) {
		delete sanitized.client_id;
	}

	return sanitized;
}

const MAX_ALERT_VALUE_LENGTH = 512;

function filledText(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const text = value.trim();
	return text.length > 0 && text.length <= MAX_ALERT_VALUE_LENGTH
		? text
		: undefined;
}

function sanitizeHttpsUrl(value: unknown): string | undefined {
	const text = filledText(value);
	if (!text) return undefined;
	try {
		return new URL(text).protocol === "https:" ? text : undefined;
	} catch {
		return undefined;
	}
}

function sanitizeAlerts(value: unknown): AlertsFileConfig | undefined {
	if (!isRecord(value)) return undefined;
	const alerts: AlertsFileConfig = {};
	const slackWebhookUrl = sanitizeHttpsUrl(value.slack_webhook_url);
	if (slackWebhookUrl) alerts.slack_webhook_url = slackWebhookUrl;
	const slackBotToken = filledText(value.slack_bot_token);
	if (slackBotToken) alerts.slack_bot_token = slackBotToken;
	const slackChannel = filledText(value.slack_channel);
	if (slackChannel) alerts.slack_channel = slackChannel;
	const email = normalizeEnrollmentEmail(value.email);
	if (email) alerts.email = email;
	const emailFrom = filledText(value.email_from);
	if (emailFrom) alerts.email_from = emailFrom;
	const resendApiKey = filledText(value.resend_api_key);
	if (resendApiKey) alerts.resend_api_key = resendApiKey;
	return alerts;
}

function isProviderStrategy(value: unknown): value is ProviderStrategy {
	return (
		typeof value === "string" &&
		(PROVIDER_STRATEGIES as readonly string[]).includes(value)
	);
}

function sanitizeProviderBaseUrl(value: unknown): string | undefined {
	if (typeof value !== "string" || value.length === 0) return undefined;
	try {
		const url = new URL(value);
		return url.protocol === "https:" || url.protocol === "http:"
			? url.toString().replace(/\/$/, "")
			: undefined;
	} catch {
		return undefined;
	}
}

function sanitizeClientRouting(
	value: unknown,
): ClientRoutingFileConfig | undefined {
	if (!isRecord(value)) return undefined;
	const client: ClientRoutingFileConfig = {};
	if (typeof value.enabled === "boolean") client.enabled = value.enabled;
	if (typeof value.base_url === "string") {
		try {
			const url = new URL(value.base_url);
			if (
				(url.protocol === "http:" || url.protocol === "https:") &&
				url.pathname === "/" &&
				url.search === "" &&
				url.hash === "" &&
				url.username === "" &&
				url.password === ""
			) {
				client.base_url = url.origin;
			}
		} catch {
			// Ignore an invalid caller target rather than generating a broken wrapper.
		}
	}
	if (
		typeof value.proxy_key_file === "string" &&
		(value.proxy_key_file.startsWith("/") ||
			value.proxy_key_file.startsWith("~/")) &&
		value.proxy_key_file.length <= 1024
	) {
		client.proxy_key_file = value.proxy_key_file;
	}
	return Object.keys(client).length > 0 ? client : undefined;
}

function sanitizeProviderModels(
	value: unknown,
): Record<string, string> | undefined {
	if (!isRecord(value)) return undefined;
	const models: Record<string, string> = {};
	for (const [pattern, target] of Object.entries(value)) {
		const wildcardIndex = pattern.indexOf("*");
		if (
			pattern.length === 0 ||
			pattern.length > 200 ||
			(wildcardIndex !== -1 && wildcardIndex !== pattern.length - 1) ||
			typeof target !== "string" ||
			target.length === 0 ||
			target.length > 200
		) {
			continue;
		}
		models[pattern] = target;
	}
	return Object.keys(models).length > 0 ? models : undefined;
}

function sanitizeProviderConfigs(
	value: unknown,
): Record<string, ProviderFileConfig> | undefined {
	if (!isRecord(value)) return undefined;

	const providers: Record<string, ProviderFileConfig> = {};
	for (const [name, entry] of Object.entries(value)) {
		if (
			name === "pool" ||
			!PROVIDER_NAME_PATTERN.test(name) ||
			!isRecord(entry)
		)
			continue;

		const builtin = BUILTIN_PROVIDER_CONFIG_BY_NAME.get(name);
		const strategy = isProviderStrategy(entry.strategy)
			? entry.strategy
			: builtin?.strategy;
		if (!strategy) continue;

		const provider: ProviderFileConfig = { strategy };
		if (typeof entry.enabled === "boolean") provider.enabled = entry.enabled;
		const baseUrl = sanitizeProviderBaseUrl(entry.base_url);
		if (baseUrl) provider.base_url = baseUrl;
		const models = sanitizeProviderModels(entry.models);
		if (models) provider.models = models;
		providers[name] = provider;
	}

	return providers;
}

function sanitizeProviderPools(
	value: unknown,
): ProviderPoolsFileConfig | undefined {
	if (!isRecord(value)) return undefined;
	const pools: ProviderPoolsFileConfig = {};
	for (const [wire, entries] of Object.entries(value)) {
		if (!isProviderWire(wire) || !Array.isArray(entries)) continue;
		const providers = [...new Set(entries)].filter(
			(provider): provider is string =>
				typeof provider === "string" && PROVIDER_NAME_PATTERN.test(provider),
		);
		if (providers.length > 0) pools[wire] = providers;
	}
	return pools;
}

function wireForStrategy(strategy: ProviderStrategy): ProviderWire {
	return strategy === "anthropic-api" || strategy === "claude-code"
		? "anthropic-messages"
		: "openai-responses";
}

function isNonNegativeFiniteNumber(value: unknown): value is number {
	return isFiniteNumber(value) && value >= 0;
}

function sanitizeTeamRouting(
	value: unknown,
): TeamRoutingFileConfig | undefined {
	if (!isRecord(value)) return undefined;
	const result: TeamRoutingFileConfig = {};
	if (typeof value.enabled === "boolean") result.enabled = value.enabled;
	if (typeof value.distribution_enabled === "boolean") {
		result.distribution_enabled = value.distribution_enabled;
	}
	if (
		Array.isArray(value.allowlisted_account_uuids) &&
		value.allowlisted_account_uuids.every(
			(entry) =>
				typeof entry === "string" && entry.length > 0 && entry.length <= 200,
		)
	) {
		result.allowlisted_account_uuids = [...value.allowlisted_account_uuids];
	}
	if (
		isFiniteNumber(value.max_usage) &&
		value.max_usage > 0 &&
		value.max_usage <= 0.9
	) {
		result.max_usage = value.max_usage;
	}
	if (isNonNegativeFiniteNumber(value.admission_cap)) {
		result.admission_cap = Math.floor(value.admission_cap);
	}
	if (isNonNegativeFiniteNumber(value.admission_queue_limit)) {
		result.admission_queue_limit = Math.floor(value.admission_queue_limit);
	}
	if (isNonNegativeFiniteNumber(value.admission_wait_ms)) {
		result.admission_wait_ms = Math.floor(value.admission_wait_ms);
	}
	if (isNonNegativeFiniteNumber(value.hold_seconds)) {
		result.hold_seconds = Math.floor(value.hold_seconds);
	}
	if (isNonNegativeFiniteNumber(value.quota_probe_seconds)) {
		result.quota_probe_seconds = Math.min(
			Math.floor(value.quota_probe_seconds),
			7 * 24 * 60 * 60,
		);
	}
	return result;
}

export class Config extends EventEmitter {
	private configPath: string;
	private data: ConfigData = {};

	constructor(configPath?: string) {
		super();
		this.configPath = configPath ?? resolveConfigPath();
		this.loadConfig();
	}

	private loadConfig(): void {
		if (existsSync(this.configPath)) {
			try {
				const content = readFileSync(this.configPath, "utf8");
				this.data = sanitizeConfigData(JSON.parse(content));
			} catch (error) {
				log.error(`Failed to parse config file: ${error}`);
				this.data = {};
				return;
			}

			try {
				chmodSync(this.configPath, 0o600);
			} catch {
				// Do not accept group/world-readable config merely because it parsed:
				// it can contain alert credentials. A protected read-only file is safe.
				let ownerOnly = false;
				try {
					ownerOnly = (statSync(this.configPath).mode & 0o077) === 0;
				} catch {
					// The clear failure below is safer than falling back to an empty config.
				}
				if (!ownerOnly) {
					throw new Error("Config file must be owner-only");
				}
			}
			if ("default_agent_model" in this.data) {
				delete this.data.default_agent_model;
				this.saveConfig();
			}
		} else {
			// Create config directory if it doesn't exist
			const dir = dirname(this.configPath);
			mkdirSync(dir, { recursive: true, mode: 0o700 });
			chmodSync(dir, 0o700);

			// Initialize with default config
			this.data = {
				lb_strategy: DEFAULT_STRATEGY,
			};
			this.saveConfig();
		}
	}

	private saveConfig(): void {
		try {
			this.writePrivately(this.data);
		} catch (error) {
			log.error(`Failed to save config file: ${error}`);
		}
	}

	/** The file holds alert credentials, so every write lands it `0600`, replacing a looser file. */
	private writePrivately(data: ConfigData): void {
		const temporary = `${this.configPath}.${crypto.randomUUID()}.tmp`;
		try {
			writeFileSync(temporary, JSON.stringify(data, null, 2), {
				mode: 0o600,
				flag: "wx",
			});
			renameSync(temporary, this.configPath);
		} finally {
			rmSync(temporary, { force: true });
		}
	}

	get(
		key: string,
		defaultValue?: string | number | boolean,
	): string | number | boolean | undefined {
		const value = this.data[key];
		if (
			typeof value === "string" ||
			typeof value === "number" ||
			typeof value === "boolean"
		) {
			return value;
		}

		if (defaultValue !== undefined) {
			this.set(key, defaultValue);
			return defaultValue;
		}

		return undefined;
	}

	set(key: string, value: string | number | boolean): void {
		const oldValue = this.data[key];
		this.data[key] = value;
		this.saveConfig();

		// Emit change event
		this.emit("change", { key, oldValue, newValue: value });
	}

	getStrategy(): StrategyName {
		// First check environment variable
		const envStrategy = process.env.LB_STRATEGY;
		if (envStrategy && isValidStrategy(envStrategy)) {
			return envStrategy;
		}

		// Then check config file
		const configStrategy = this.data.lb_strategy;
		if (configStrategy && isValidStrategy(configStrategy)) {
			return configStrategy;
		}

		return DEFAULT_STRATEGY;
	}

	setStrategy(strategy: StrategyName): void {
		if (!isValidStrategy(strategy)) {
			throw new Error(`Invalid strategy: ${strategy}`);
		}
		this.set("lb_strategy", strategy);
	}

	private clamp(n: number, min: number, max: number): number {
		return Math.max(min, Math.min(max, n));
	}

	getDataRetentionDays(): number {
		const fromEnv = process.env.DATA_RETENTION_DAYS;
		if (fromEnv) {
			const n = parseInt(fromEnv, 10);
			if (!Number.isNaN(n)) return this.clamp(n, 1, 365);
		}
		const fromFile = this.data.data_retention_days;
		if (typeof fromFile === "number") return this.clamp(fromFile, 1, 365);
		return 7;
	}

	setDataRetentionDays(days: number): void {
		const clamped = this.clamp(days, 1, 365);
		this.set("data_retention_days", clamped);
	}

	getRequestRetentionDays(): number {
		const fromEnv = process.env.REQUEST_RETENTION_DAYS;
		if (fromEnv) {
			const n = parseInt(fromEnv, 10);
			if (!Number.isNaN(n)) return this.clamp(n, 1, 3650);
		}
		const fromFile = this.data.request_retention_days;
		if (typeof fromFile === "number") return this.clamp(fromFile, 1, 3650);
		return 365; // default metadata retention
	}

	setRequestRetentionDays(days: number): void {
		const clamped = this.clamp(days, 1, 3650);
		this.set("request_retention_days", clamped);
	}

	getAllSettings(): Record<string, string | number | boolean | undefined> {
		// Include current strategy (which might come from env)
		const primitiveSettings = Object.fromEntries(
			Object.entries(this.data).filter(
				([, value]) =>
					typeof value === "string" ||
					typeof value === "number" ||
					typeof value === "boolean",
			),
		) as Record<string, string | number | boolean>;
		return {
			...primitiveSettings,
			lb_strategy: this.getStrategy(),
			data_retention_days: this.getDataRetentionDays(),
			request_retention_days: this.getRequestRetentionDays(),
		};
	}

	getTeamRouting(): TeamRoutingConfig {
		const file = this.data.team_routing;
		return {
			enabled: file?.enabled ?? TEAM_ROUTING_DEFAULTS.enabled,
			distributionEnabled:
				file?.distribution_enabled ?? TEAM_ROUTING_DEFAULTS.distributionEnabled,
			allowlistedAccountUuids: [
				...(file?.allowlisted_account_uuids ??
					TEAM_ROUTING_DEFAULTS.allowlistedAccountUuids),
			],
			maxUsage: file?.max_usage ?? TEAM_ROUTING_DEFAULTS.maxUsage,
			admissionCap: file?.admission_cap ?? TEAM_ROUTING_DEFAULTS.admissionCap,
			admissionQueueLimit:
				file?.admission_queue_limit ??
				TEAM_ROUTING_DEFAULTS.admissionQueueLimit,
			admissionWaitMs:
				file?.admission_wait_ms ?? TEAM_ROUTING_DEFAULTS.admissionWaitMs,
			holdSeconds: file?.hold_seconds ?? TEAM_ROUTING_DEFAULTS.holdSeconds,
			quotaProbeSeconds:
				file?.quota_probe_seconds ?? TEAM_ROUTING_DEFAULTS.quotaProbeSeconds,
		};
	}

	getAlerts(): AlertsConfig {
		const file = this.data.alerts;
		return {
			slackWebhookUrl: file?.slack_webhook_url ?? null,
			slackBotToken: file?.slack_bot_token ?? null,
			slackChannel: file?.slack_channel ?? null,
			email: file?.email ?? null,
			emailFrom: file?.email_from ?? null,
			resendApiKey: file?.resend_api_key ?? null,
		};
	}

	getClientRouting(): ClientRoutingConfig {
		const client = this.data.client;
		return {
			enabled: client?.enabled === true,
			...(client?.base_url && { baseUrl: client.base_url }),
			...(client?.proxy_key_file && {
				proxyKeyFile: client.proxy_key_file,
			}),
		};
	}

	/** On unless the file says `false`: a full fleet refuses requests rather than spend extra usage. */
	getBlockWhenAllFull(): boolean {
		return this.data.block_when_all_full !== false;
	}

	getProviderConfig(name: string): ProviderConfig | undefined {
		const builtin = BUILTIN_PROVIDER_CONFIG_BY_NAME.get(name);
		const configured = this.data.providers?.[name];
		if (!builtin && !configured?.strategy) return undefined;

		return {
			name,
			enabled: configured?.enabled ?? builtin?.enabled ?? true,
			strategy: configured?.strategy ?? builtin?.strategy ?? "anthropic-api",
			...(configured?.base_url && { baseUrl: configured.base_url }),
			...(configured?.models && { models: { ...configured.models } }),
		};
	}

	getProviderPool(wire: ProviderWire): string[] {
		return (this.data.provider_pools?.[wire] ?? []).filter((name) => {
			const provider = this.getProviderConfig(name);
			return (
				provider?.enabled === true &&
				wireForStrategy(provider.strategy) === wire
			);
		});
	}

	getProviderPools(): ProviderPoolsFileConfig {
		return Object.fromEntries(
			PROVIDER_WIRES.map((wire) => [wire, this.getProviderPool(wire)]).filter(
				([, providers]) => providers.length > 0,
			),
		) as ProviderPoolsFileConfig;
	}

	getProviderConfigs(): ProviderConfig[] {
		const names = new Set(BUILTIN_PROVIDER_CONFIGS.map(({ name }) => name));
		for (const name of Object.keys(this.data.providers ?? {})) {
			names.add(name);
		}
		return [...names]
			.map((name) => this.getProviderConfig(name))
			.filter((provider): provider is ProviderConfig => provider !== undefined);
	}

	/**
	 * Replaces the team-routing policy as one validated unit. This deliberately
	 * does not accept unknown fields: an operator should never believe an
	 * admission or quota guard is enabled when its setting was ignored.
	 */
	setTeamRouting(value: unknown): void {
		if (!isRecord(value)) {
			throw new Error("team routing configuration must be an object");
		}
		const allowed = new Set([
			"enabled",
			"distribution_enabled",
			"allowlisted_account_uuids",
			"max_usage",
			"admission_cap",
			"admission_queue_limit",
			"admission_wait_ms",
			"hold_seconds",
			"quota_probe_seconds",
		]);
		if (Object.keys(value).some((key) => !allowed.has(key))) {
			throw new Error("team routing configuration contains an unknown field");
		}
		const sanitized = sanitizeTeamRouting(value);
		if (!sanitized) {
			throw new Error("team routing configuration must be an object");
		}
		for (const key of Object.keys(value)) {
			if (!(key in sanitized)) {
				throw new Error(`Invalid team routing field: ${key}`);
			}
		}
		const oldValue = this.data.team_routing;
		this.data.team_routing = sanitized;
		this.saveConfig();
		this.emit("change", {
			key: "team_routing",
			oldValue,
			newValue: sanitized,
		});
	}

	/** Persist a consented seat without changing routing enablement or limits. */
	allowAccountUuid(accountUuid: string): void {
		const current = this.getTeamRouting().allowlistedAccountUuids;
		if (current.includes(accountUuid)) return;
		this.persistAccountAllowlist([...current, accountUuid]);
	}

	/** Remove only this membership, with the same strict persistence as enrollment. */
	removeAccountUuid(accountUuid: string): void {
		const current = this.getTeamRouting().allowlistedAccountUuids;
		if (!current.includes(accountUuid)) return;
		this.persistAccountAllowlist(
			current.filter((uuid) => uuid !== accountUuid),
		);
	}

	private persistAccountAllowlist(accountUuids: string[]): void {
		this.persistStrictly("team_routing", {
			...this.data.team_routing,
			allowlisted_account_uuids: accountUuids,
		});
	}

	getEnrollmentEmails(): string[] {
		return [...(this.data.enrollment_emails ?? [])];
	}

	/** Replaces the stable-link email list live; one invalid entry refuses the whole list. */
	setEnrollmentEmails(emails: readonly string[]): string[] {
		const normalized = emails.map(normalizeEnrollmentEmail);
		if (normalized.some((email) => email === undefined)) {
			throw new ValidationError(
				"Invalid enrollment email",
				"enrollment_emails",
			);
		}
		const unique = [...new Set(normalized as string[])];
		if (unique.length > MAX_ENROLLMENT_EMAILS) {
			throw new ValidationError(
				`At most ${MAX_ENROLLMENT_EMAILS} enrollment emails`,
				"enrollment_emails",
			);
		}
		this.persistStrictly("enrollment_emails", unique);
		return [...unique];
	}

	/** Atomic write that throws, unlike saveConfig, so a caller can roll back. */
	private persistStrictly<K extends "team_routing" | "enrollment_emails">(
		key: K,
		value: NonNullable<ConfigData[K]>,
	): void {
		const next: ConfigData = { ...this.data, [key]: value };
		this.writePrivately(next);
		const oldValue = this.data[key];
		this.data = next;
		this.emit("change", { key, oldValue, newValue: value });
	}

	getRuntime(): RuntimeConfig {
		// Default values
		const defaults: RuntimeConfig = {
			blockWhenAllFull: this.getBlockWhenAllFull(),
			clientId: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
			maxBodyBytes: 64 * 1024 * 1024,
			quotaThreshold: 0.98,
			requestScopedRetryDelayMs: 2000,
			retry: {
				attempts: 3,
				delayMs: TIME_CONSTANTS.RETRY_DELAY_DEFAULT,
				backoff: 2,
			},
			sessionDurationMs: TIME_CONSTANTS.SESSION_DURATION_DEFAULT,
			port: NETWORK.DEFAULT_PORT,
			teamRouting: this.getTeamRouting(),
		};

		// Override with environment variables if present
		if (process.env.CLIENT_ID) {
			defaults.clientId = process.env.CLIENT_ID;
		}
		const retryAttempts = parseNumber(process.env.RETRY_ATTEMPTS);
		if (retryAttempts !== undefined) {
			defaults.retry.attempts = retryAttempts;
		}
		const maxBodyBytes = parseNumber(process.env.MAX_BODY_BYTES);
		if (maxBodyBytes !== undefined) {
			defaults.maxBodyBytes = maxBodyBytes;
		}
		const quotaThreshold = parseNumber(process.env.QUOTA_THRESHOLD);
		if (
			quotaThreshold !== undefined &&
			quotaThreshold > 0 &&
			quotaThreshold <= 1
		) {
			defaults.quotaThreshold = quotaThreshold;
		}
		const retryDelayMs = parseNumber(process.env.RETRY_DELAY_MS);
		if (retryDelayMs !== undefined) {
			defaults.retry.delayMs = retryDelayMs;
		}
		const retryBackoff = parseNumber(process.env.RETRY_BACKOFF);
		if (retryBackoff !== undefined) {
			defaults.retry.backoff = retryBackoff;
		}
		const requestScopedRetryDelayMs = parseNumber(
			process.env.REQUEST_SCOPED_429_RETRY_DELAY_MS,
		);
		if (requestScopedRetryDelayMs !== undefined) {
			defaults.requestScopedRetryDelayMs = requestScopedRetryDelayMs;
		}
		const sessionDurationMs = parseNumber(process.env.SESSION_DURATION_MS);
		if (sessionDurationMs !== undefined) {
			defaults.sessionDurationMs = sessionDurationMs;
		}
		const port = parseNumber(process.env.PORT);
		if (port !== undefined) {
			defaults.port = port;
		}

		// Override with config file settings if present
		if (this.data.client_id) {
			defaults.clientId = this.data.client_id;
		}
		if (typeof this.data.retry_attempts === "number") {
			defaults.retry.attempts = this.data.retry_attempts;
		}
		if (typeof this.data.max_body_bytes === "number") {
			defaults.maxBodyBytes = this.data.max_body_bytes;
		}
		if (
			typeof this.data.quota_threshold === "number" &&
			this.data.quota_threshold > 0 &&
			this.data.quota_threshold <= 1
		) {
			defaults.quotaThreshold = this.data.quota_threshold;
		}
		if (typeof this.data.retry_delay_ms === "number") {
			defaults.retry.delayMs = this.data.retry_delay_ms;
		}
		if (typeof this.data.retry_backoff === "number") {
			defaults.retry.backoff = this.data.retry_backoff;
		}
		if (typeof this.data.request_scoped_429_retry_delay_ms === "number") {
			defaults.requestScopedRetryDelayMs =
				this.data.request_scoped_429_retry_delay_ms;
		}
		if (typeof this.data.session_duration_ms === "number") {
			defaults.sessionDurationMs = this.data.session_duration_ms;
		}
		if (typeof this.data.port === "number") {
			defaults.port = this.data.port;
		}

		return defaults;
	}
}

export { resolveConfigPath } from "./paths";
export { getPlatformConfigDir } from "./paths-common";
