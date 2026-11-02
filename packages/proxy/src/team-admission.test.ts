import { expect, test } from "bun:test";
import { TeamAdmission } from "./team-admission";

const config = {
	enabled: true,
	distributionEnabled: true,
	allowlistedAccountUuids: ["acct-a"],
	maxUsage: 0.9,
	admissionCap: 1,
	admissionQueueLimit: 1,
	admissionWaitMs: 1_000,
	holdSeconds: 0,
	quotaProbeSeconds: 0,
};

test("queues one request behind a full account and grants it FIFO on release", async () => {
	const admission = new TeamAdmission();
	const first = await admission.acquire("a", config);
	let secondGranted = false;
	const second = admission.acquire("a", config).then((permit) => {
		secondGranted = true;
		return permit;
	});

	await Promise.resolve();
	expect(secondGranted).toBe(false);
	first.release();
	expect(secondGranted).toBe(false);
	const secondPermit = await second;
	expect(secondGranted).toBe(true);
	secondPermit.release();
});

test("starts a switched account at one permit and raises its cap as the clock advances", async () => {
	let now = 1_700_000_000_000;
	const admission = new TeamAdmission(() => now);
	admission.armSwitch("a");
	const first = await admission.acquire("a", { ...config, admissionCap: 3 });
	let secondGranted = false;
	const second = admission
		.acquire("a", { ...config, admissionCap: 3 })
		.then((permit) => {
			secondGranted = true;
			return permit;
		});

	await Promise.resolve();
	expect(secondGranted).toBe(false);
	now += 250;
	admission.advance();
	const secondPermit = await second;
	expect(secondGranted).toBe(true);
	first.release();
	secondPermit.release();
});
