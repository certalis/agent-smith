import { test } from "bun:test";
import { reachScenarios } from "./api-key-account-reach.scenario";
import { runScenario } from "./harness/runner";

for (const scenario of reachScenarios.slice(1)) {
	test(scenario.name, () => runScenario(scenario), 30_000);
}
