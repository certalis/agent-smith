import {
	type AuthMethod,
	isProviderWire,
	type ProviderWire,
} from "@ccflare/types";
import type { OAuthProvider, Provider } from "./types";

type ProviderWithOAuth = Provider & {
	supportsOAuth: () => boolean;
	getOAuthProvider: () => OAuthProvider;
};

export interface ResolvedProvider {
	provider: Provider;
	upstreamPath: string;
	query: string;
}

export interface ResolvedProviderPool {
	wire: ProviderWire;
	upstreamPath: string;
	query: string;
	providers: Array<{ provider: Provider; model: string | undefined }>;
}

type ProviderRoutingConfig = {
	modelMaps?: Record<string, Record<string, string> | undefined>;
	providerPools?: Partial<Record<ProviderWire, readonly string[]>>;
};

function supportsOAuth(provider: Provider): provider is ProviderWithOAuth {
	return (
		"supportsOAuth" in provider &&
		typeof provider.supportsOAuth === "function" &&
		"getOAuthProvider" in provider &&
		typeof provider.getOAuthProvider === "function"
	);
}

export class ProviderRegistry {
	private providers = new Map<string, Provider>();
	private oauthProviders = new Map<string, OAuthProvider>();
	private readonly modelMaps: Record<
		string,
		Record<string, string> | undefined
	>;
	private readonly providerPools: Partial<
		Record<ProviderWire, readonly string[]>
	>;

	constructor(providers: Provider[] = [], routing: ProviderRoutingConfig = {}) {
		this.modelMaps = routing.modelMaps ?? {};
		this.providerPools = routing.providerPools ?? {};
		for (const provider of providers) {
			this.registerProvider(provider);
		}
	}

	private modelFor(
		providerName: string,
		requested: string | undefined,
	): string | undefined {
		const models = this.modelMaps[providerName];
		if (!models) return requested;
		if (!requested) return undefined;
		if (models[requested]) return models[requested];
		const wildcard = Object.entries(models)
			.filter(
				([pattern]) =>
					pattern.endsWith("*") && requested.startsWith(pattern.slice(0, -1)),
			)
			.sort(([left], [right]) => right.length - left.length)[0];
		return wildcard?.[1];
	}

	/**
	 * Register a provider
	 */
	registerProvider(provider: Provider): void {
		this.providers.set(provider.name, provider);

		// Auto-register OAuth provider if supported
		if (supportsOAuth(provider) && provider.supportsOAuth()) {
			this.oauthProviders.set(provider.name, provider.getOAuthProvider());
		}
	}

	/**
	 * Get a provider by name
	 */
	getProvider(name: string): Provider | undefined {
		return this.providers.get(name);
	}

	getProviderAuthMethod(name: string): AuthMethod | undefined {
		const provider = this.getProvider(name);
		if (!provider) return undefined;
		return supportsOAuth(provider) && provider.supportsOAuth()
			? "oauth"
			: "api_key";
	}

	/**
	 * Get an OAuth provider by name
	 */
	getOAuthProvider(name: string): OAuthProvider | undefined {
		return this.oauthProviders.get(name);
	}

	getOAuthCallbackForwarder(
		name: string,
	): { port: number; targetPath: string } | undefined {
		return this.getProvider(name)?.getOAuthCallbackForwarder?.();
	}

	/**
	 * List all registered provider names
	 */
	listProviders(): string[] {
		return Array.from(this.providers.keys());
	}

	/**
	 * List all providers that support OAuth
	 */
	listOAuthProviders(): string[] {
		return Array.from(this.oauthProviders.keys());
	}

	/**
	 * Resolve a provider-prefixed route into a provider and upstream path.
	 */
	resolveProvider(pathname: string): ResolvedProvider | null {
		const queryIndex = pathname.indexOf("?");
		const path = queryIndex >= 0 ? pathname.slice(0, queryIndex) : pathname;
		const query = queryIndex >= 0 ? pathname.slice(queryIndex) : "";

		if (!path.startsWith("/v1/")) {
			return null;
		}

		const remainder = path.slice("/v1/".length);
		if (!remainder) {
			return null;
		}

		const slashIndex = remainder.indexOf("/");
		const providerName =
			slashIndex >= 0 ? remainder.slice(0, slashIndex) : remainder;

		if (!providerName) {
			return null;
		}

		const provider = this.getProvider(providerName);
		if (!provider) {
			return null;
		}

		const upstreamPath =
			slashIndex >= 0 ? remainder.slice(slashIndex) || "/" : "/";

		return {
			provider,
			upstreamPath,
			query,
		};
	}

	resolvePool(
		pathname: string,
		requestedModel: string | undefined,
	): ResolvedProviderPool | null {
		const queryIndex = pathname.indexOf("?");
		const path = queryIndex >= 0 ? pathname.slice(0, queryIndex) : pathname;
		const query = queryIndex >= 0 ? pathname.slice(queryIndex) : "";
		const match = /^\/v1\/pool\/([^/]+)(\/.*)?$/.exec(path);
		if (!match || !isProviderWire(match[1])) return null;
		const wire = match[1];
		const upstreamPath = match[2] || "/";
		const providers = [...new Set(this.providerPools[wire] ?? [])].flatMap(
			(name) => {
				const provider = this.getProvider(name);
				const model = this.modelFor(name, requestedModel);
				return provider?.wire === wire && model !== undefined
					? [{ provider, model }]
					: [];
			},
		);
		return { wire, upstreamPath, query, providers };
	}

	/**
	 * Unregister a provider (useful for testing)
	 */
	unregisterProvider(name: string): boolean {
		this.oauthProviders.delete(name);
		return this.providers.delete(name);
	}

	/**
	 * Clear all providers (useful for testing)
	 */
	clear(): void {
		this.providers.clear();
		this.oauthProviders.clear();
	}
}

export const createProviderRegistry = (providers: Provider[] = []) =>
	new ProviderRegistry(providers);
