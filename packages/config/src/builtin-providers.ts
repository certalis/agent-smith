/** Provider identities and default strategies shared by configuration and migration. */
export const BUILTIN_PROVIDER_CONFIGS = [
	{ name: "anthropic", enabled: true, strategy: "anthropic-api" },
	{ name: "openai", enabled: true, strategy: "openai-api" },
	{ name: "claude-code", enabled: false, strategy: "claude-code" },
	{ name: "codex", enabled: false, strategy: "codex" },
] as const;
