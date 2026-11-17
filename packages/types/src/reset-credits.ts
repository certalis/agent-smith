/** Limited provider grants, not money or paid inference credits. */
export type ResetCredit = {
	id: string;
	resetType: string;
	status: string;
	grantedAt: string;
	expiresAt: string | null;
	title: string | null;
	description: string | null;
};

export type ResetCredits = { availableCount: number; credits: ResetCredit[] };
export type ResetCreditRequest = { creditId: string; requestId: string };
export type ResetCreditResult = {
	code: "reset" | "nothing_to_reset" | "no_credit" | "already_redeemed";
	windowsReset: number;
};
export type ManualResetResult = ResetCreditResult & { quotaRefreshed: boolean };
