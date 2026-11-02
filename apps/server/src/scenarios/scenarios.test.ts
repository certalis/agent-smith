import { test } from "bun:test";
import { runScenario } from "./harness/runner";
import type { Scenario } from "./harness/scenario";

const scenarioFiles = await Array.fromAsync(
	new Bun.Glob("*.scenario.ts").scan({ cwd: import.meta.dir }),
);

for (const file of scenarioFiles.sort()) {
	const module = (await import(`./${file}`)) as { default: Scenario };
	const scenario = module.default;
	const prefix = scenario.expectedRed ? "[expected red] " : "";

	test(`${prefix}${scenario.name}`, () => runScenario(scenario), 30_000);
}
