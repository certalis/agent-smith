import { getProviderDisplayLabel } from "@ccflare/types";
import { Badge } from "./ui/badge";

function getProviderLabel(provider: string): string {
	if (!provider) {
		return "Unknown";
	}

	return getProviderDisplayLabel(provider);
}

interface ProviderBadgeProps {
	provider: string;
	className?: string;
}

export function ProviderBadge({ provider, className }: ProviderBadgeProps) {
	return (
		<Badge variant="outline" className={className}>
			{getProviderLabel(provider)}
		</Badge>
	);
}
