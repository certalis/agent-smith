export const PROVIDER_BLOCK_CATEGORIES = [
	"five-hour-limit",
	"weekly-limit",
	"request-rate",
	"token-allocation",
	"burst",
	"dynamic-throughput",
	"temporary-capacity",
	"unknown",
] as const;

export type ProviderBlockCategory = (typeof PROVIDER_BLOCK_CATEGORIES)[number];

export type ProviderCapacityBlock = {
	category: ProviderBlockCategory;
	retryAt?: number;
};

/** Connector-owned translation of an upstream response into a capacity fact. */
export interface CapacitySource {
	getCapacityBlock?(response: Response): Promise<ProviderCapacityBlock | null>;
}

export function isProviderBlockCategory(
	value: unknown,
): value is ProviderBlockCategory {
	return (
		typeof value === "string" &&
		(PROVIDER_BLOCK_CATEGORIES as readonly string[]).includes(value)
	);
}

export type {
	Availability,
	EdgeRequest,
	ProviderStatus,
	RoutedProvider,
	RouteRequest,
	RouteScope,
	ServeOutcome,
	SessionOutcome,
} from "./routed-provider";
