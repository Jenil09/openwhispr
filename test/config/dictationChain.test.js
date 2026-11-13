const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/config/dictationChain.ts");

test("normalizeChainSettings drops junk and fills defaults", async () => {
  const { normalizeChainSettings } = await load();
  const settings = normalizeChainSettings({
    enabled: true,
    steps: [null, "x", { name: "Formal", prompt: "Be formal", inference: { mode: "bogus" } }],
  });
  assert.equal(settings.enabled, true);
  assert.equal(settings.requireApproval, true);
  assert.equal(settings.steps.length, 1);
  assert.equal(settings.steps[0].name, "Formal");
  assert.equal(settings.steps[0].inference.mode, "providers");
  assert.ok(settings.steps[0].id);
  assert.deepEqual(normalizeChainSettings("garbage").steps, []);
});

test("stepProblem names what a step is missing", async () => {
  const { createStep, stepProblem } = await load();
  assert.equal(stepProblem(createStep({ enabled: false })), "disabled");
  assert.equal(stepProblem(createStep({ prompt: "  " })), "noPrompt");
  assert.equal(stepProblem(createStep()), "noModel");
  assert.equal(
    stepProblem(
      createStep({ inference: { mode: "providers", provider: "openai", model: "gpt-x" } })
    ),
    null
  );
  assert.equal(
    stepProblem(createStep({ inference: { mode: "providers", provider: "custom", model: "m" } })),
    "noEndpoint"
  );
  assert.equal(stepProblem(createStep({ inference: { mode: "self-hosted" } })), "noEndpoint");
  assert.equal(
    stepProblem(createStep({ inference: { mode: "self-hosted", remoteUrl: "http://lan:11434" } })),
    null
  );
  assert.equal(stepProblem(createStep({ inference: { mode: "local", model: "qwen" } })), null);
});

test("buildStepRequest routes each mode to its provider", async () => {
  const { createStep, buildStepRequest } = await load();

  const local = buildStepRequest(createStep({ inference: { mode: "local", model: " qwen3 " } }));
  assert.equal(local.model, "qwen3");
  assert.equal(local.config.provider, "local");
  assert.equal(local.config.lanUrl, undefined);

  const lan = buildStepRequest(
    createStep({
      inference: { mode: "self-hosted", remoteUrl: "http://lan:11434/v1", customApiKey: "k" },
    })
  );
  assert.equal(lan.config.provider, "lan");
  assert.equal(lan.config.lanUrl, "http://lan:11434/v1");
  assert.equal(lan.config.customApiKey, "k");

  const byok = buildStepRequest(
    createStep({
      inference: { mode: "providers", provider: "anthropic", model: "m", customApiKey: "leak" },
    })
  );
  assert.equal(byok.config.provider, "anthropic");
  // A key typed for a custom endpoint never rides along to a named provider.
  assert.equal(byok.config.customApiKey, undefined);
  assert.equal(byok.config.baseUrl, undefined);

  const custom = buildStepRequest(
    createStep({
      inference: {
        mode: "providers",
        provider: "custom",
        model: "m",
        cloudBaseUrl: "https://x/v1",
        customApiKey: "k",
      },
    })
  );
  assert.equal(custom.config.baseUrl, "https://x/v1");
  assert.equal(custom.config.customApiKey, "k");

  for (const request of [local, lan, byok, custom]) {
    assert.ok(request.config.systemPrompt.includes("<input>"));
    assert.equal(request.config.requireCompleteOutput, true);
  }
});

test("cleanStepOutput strips echoed wrappers and fences", async () => {
  const { cleanStepOutput, wrapStepInput } = await load();
  assert.equal(cleanStepOutput(wrapStepInput("hello")), "hello");
  assert.equal(cleanStepOutput("```\nhello\n```"), "hello");
  assert.equal(cleanStepOutput("  plain  "), "plain");
});

test("chainIsActive needs the switch and a runnable step", async () => {
  const { chainIsActive, createStep } = await load();
  const ready = createStep({ inference: { mode: "local", model: "q" } });
  assert.equal(chainIsActive({ enabled: false, requireApproval: true, steps: [ready] }), false);
  assert.equal(
    chainIsActive({ enabled: true, requireApproval: true, steps: [createStep()] }),
    false
  );
  assert.equal(chainIsActive({ enabled: true, requireApproval: true, steps: [ready] }), true);
});

test("revision uses the last runnable step's model and keeps its style", async () => {
  const { createStep, revisionStep, buildRevisionRequest, wrapRevisionInput } = await load();
  const first = createStep({ name: "A", inference: { mode: "local", model: "small" } });
  const last = createStep({
    name: "B",
    prompt: "Sound corporate.",
    inference: { mode: "providers", provider: "gemini", model: "g" },
  });
  const broken = createStep({ name: "C", prompt: "" });
  const settings = { enabled: false, requireApproval: true, steps: [first, last, broken] };

  assert.equal(revisionStep(settings).name, "B");
  assert.equal(revisionStep({ ...settings, steps: [broken] }), null);

  const request = buildRevisionRequest(last);
  assert.equal(request.model, "g");
  assert.equal(request.config.provider, "gemini");
  assert.ok(request.config.systemPrompt.includes("<instruction>"));
  assert.ok(request.config.systemPrompt.includes("Sound corporate."));

  const input = wrapRevisionInput("Hello team", "make it shorter");
  assert.ok(input.includes("<draft>\nHello team\n</draft>"));
  assert.ok(input.includes("<instruction>\nmake it shorter\n</instruction>"));
});

test("review opacity defaults to 95% and stays within 50–100%", async () => {
  const { normalizeChainSettings, clampReviewOpacity } = await load();
  assert.equal(normalizeChainSettings({}).reviewOpacity, 0.95);
  assert.equal(normalizeChainSettings({ reviewOpacity: 0.7 }).reviewOpacity, 0.7);
  assert.equal(clampReviewOpacity(0.1), 0.5);
  assert.equal(clampReviewOpacity(3), 1);
  assert.equal(clampReviewOpacity("x"), 0.95);
});
