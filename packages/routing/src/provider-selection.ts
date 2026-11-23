import type { ProviderChoice } from "./provider-choice";

export type ProviderSelection = {
	pinnedProvider?: string;
	preferredProvider?: string;
	requestedProvider?: string | null;
};

/** Orders configured providers without account, credential, or pool knowledge. */
export function preferProviders<T>(
	providers: readonly T[],
	providerName: (provider: T) => string,
	pinnedProvider?: string,
	preferredProvider?: string,
): T[] {
	const pinFirst = pinnedProvider
		? [
				...providers.filter(
					(provider) => providerName(provider) === pinnedProvider,
				),
				...providers.filter(
					(provider) => providerName(provider) !== pinnedProvider,
				),
			]
		: [...providers];
	if (!preferredProvider) return pinFirst;
	return [
		...pinFirst.filter(
			(provider) => providerName(provider) === preferredProvider,
		),
		...pinFirst.filter(
			(provider) => providerName(provider) !== preferredProvider,
		),
	];
}

/** Chooses no more providers than the routing policy permits this request to try. */
export function selectPoolProviders<T>(
	providers: readonly T[],
	providerName: (provider: T) => string,
	selection: ProviderSelection,
): T[] {
	if (selection.requestedProvider) {
		return providers.filter(
			(provider) => providerName(provider) === selection.requestedProvider,
		);
	}
	const preferred = preferProviders(
		providers,
		providerName,
		selection.pinnedProvider,
		selection.preferredProvider,
	);
	return preferred.slice(0, 1);
}

/** Returns eligible providers higher than the active pin, in configured order. */
export function higherRankedProviderChoices(
	choices: readonly ProviderChoice[],
	selectedProvider: string,
	eligibleProviders: ReadonlySet<string>,
	canOffer: (provider: string) => boolean,
): ProviderChoice[] {
	const selectedIndex = choices.findIndex(
		(choice) => choice.provider === selectedProvider,
	);
	if (selectedIndex <= 0) return [];
	return choices
		.slice(0, selectedIndex)
		.filter(
			(choice) =>
				eligibleProviders.has(choice.provider) && canOffer(choice.provider),
		);
}
