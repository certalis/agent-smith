import { expect, test } from "bun:test";
import { at } from "./scenario";

test("rejects durations outside the scenario format", () => {
	expect(() => at("tomorrow" as "1h")).toThrow("Invalid scenario duration");
});
