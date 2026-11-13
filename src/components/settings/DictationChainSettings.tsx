import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, ChevronUp, Cpu, Key, Network, Plus, Trash2 } from "../icons";
import { DICTATION_CHAIN_NS } from "../../config/dictationChainI18n";
import {
  stepProblem,
  runnableSteps,
  type ChainStep,
  type ChainStepInference,
  type ChainStepMode,
} from "../../config/dictationChain";
import { useDictationChainStore } from "../../stores/dictationChainStore";
import { useSettingsStore } from "../../stores/settingsStore";
import { runDictationChain } from "../../services/dictationChain";
import { getAgentName } from "../../utils/agentName";
import { offersThinkingToggle } from "../../services/ai/thinkingSuppression";
import { modeSwitchPatch } from "../../utils/llmModeSwitch";
import { Toggle } from "../ui/toggle";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import {
  InferenceModeSelector,
  SectionHeader,
  SettingsPanel,
  SettingsPanelRow,
  SettingsRow,
  type InferenceModeOption,
} from "../ui/SettingsSection";
import ReasoningModelSelector from "../ReasoningModelSelector";
import OpenAICompatiblePanel from "../OpenAICompatiblePanel";
import type { InferenceMode } from "../../types/electron";

function StepModelEditor({
  inference,
  onPatch,
}: {
  inference: ChainStepInference;
  onPatch: (patch: Partial<ChainStepInference>) => void;
}) {
  const { t } = useTranslation();
  const { t: tc } = useTranslation(DICTATION_CHAIN_NS);

  const modes: InferenceModeOption[] = [
    {
      id: "providers",
      label: t("settingsPage.aiModels.modes.providers"),
      description: t("settingsPage.aiModels.modes.providersDesc"),
      icon: <Key className="w-4 h-4" />,
    },
    {
      id: "local",
      label: t("settingsPage.aiModels.modes.local"),
      description: t("settingsPage.aiModels.modes.localDesc"),
      icon: <Cpu className="w-4 h-4" />,
    },
    {
      id: "self-hosted",
      label: t("settingsPage.aiModels.modes.selfHosted"),
      description: t("settingsPage.aiModels.modes.selfHostedDesc"),
      icon: <Network className="w-4 h-4" />,
    },
  ];

  const selectMode = (mode: InferenceMode) => {
    if (mode === inference.mode || !modes.some((m) => m.id === mode)) return;
    const patch = modeSwitchPatch({ provider: inference.provider, model: inference.model }, mode);
    onPatch({
      mode: mode as ChainStepMode,
      ...(patch.provider !== undefined ? { provider: patch.provider } : {}),
      ...(patch.model !== undefined ? { model: patch.model } : {}),
    });
  };

  const renderSelector = (mode: "cloud" | "local") => (
    <ReasoningModelSelector
      reasoningModel={inference.model}
      setReasoningModel={(model) => onPatch({ model })}
      localReasoningProvider={inference.provider}
      setLocalReasoningProvider={(provider) => onPatch({ provider })}
      cloudReasoningBaseUrl={inference.cloudBaseUrl}
      setCloudReasoningBaseUrl={(cloudBaseUrl) => onPatch({ cloudBaseUrl })}
      customReasoningApiKey={inference.customApiKey}
      setCustomReasoningApiKey={(customApiKey) => onPatch({ customApiKey })}
      setReasoningMode={selectMode}
      mode={mode}
    />
  );

  return (
    <div className="space-y-3">
      <p className="text-xs font-medium text-foreground">{tc("settings.model")}</p>
      <InferenceModeSelector modes={modes} activeMode={inference.mode} onSelect={selectMode} />
      {inference.mode === "providers" && renderSelector("cloud")}
      {inference.mode === "local" && renderSelector("local")}
      {inference.mode === "self-hosted" && (
        <OpenAICompatiblePanel
          baseUrl={inference.remoteUrl}
          setBaseUrl={(remoteUrl) => onPatch({ remoteUrl })}
          apiKey={inference.customApiKey}
          setApiKey={(customApiKey) => onPatch({ customApiKey })}
          model={inference.model}
          setModel={(model) => onPatch({ model })}
          baseUrlPlaceholder="http://192.168.1.126:11434/v1"
        />
      )}
      {offersThinkingToggle(inference.mode, inference.provider, inference.model) && (
        <div className="flex items-start justify-between gap-3 pt-1">
          <div className="min-w-0 flex-1">
            <h4 className="text-sm font-medium text-foreground">
              {t("reasoning.disableThinking.label")}
            </h4>
            <p className="text-xs text-muted-foreground">{t("reasoning.disableThinking.help")}</p>
          </div>
          <Toggle
            checked={inference.disableThinking}
            onChange={(disableThinking) => onPatch({ disableThinking })}
          />
        </div>
      )}
    </div>
  );
}

function StepTester({ step }: { step: ChainStep }) {
  const { t } = useTranslation(DICTATION_CHAIN_NS);
  const [sample, setSample] = useState("");
  const [running, setRunning] = useState(false);
  const [output, setOutput] = useState<{ text: string; error?: string } | null>(null);

  const run = async () => {
    if (!sample.trim()) return;
    setRunning(true);
    setOutput(null);
    try {
      const result = await runDictationChain(
        sample.trim(),
        { enabled: true, requireApproval: false, steps: [{ ...step, enabled: true }] },
        getAgentName() || null
      );
      const stage = result.stages[0];
      setOutput(stage ? { text: stage.text, error: stage.error } : { text: result.text });
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="space-y-2">
      <div className="flex items-start gap-2">
        <Textarea
          value={sample}
          onChange={(e) => setSample(e.target.value)}
          placeholder={t("settings.test.placeholder")}
          className="min-h-[56px] text-xs"
        />
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={running || !sample.trim() || stepProblem({ ...step, enabled: true }) !== null}
          onClick={run}
        >
          {running ? t("settings.test.running") : t("settings.test.button")}
        </Button>
      </div>
      {output &&
        (output.error ? (
          <p className="text-xs text-destructive">
            {t("settings.test.failed", { error: output.error })}
          </p>
        ) : (
          <p className="whitespace-pre-wrap rounded-lg bg-muted/50 px-3 py-2 text-xs">
            {output.text}
          </p>
        ))}
    </div>
  );
}

function StepCard({ step, index, count }: { step: ChainStep; index: number; count: number }) {
  const { t } = useTranslation(DICTATION_CHAIN_NS);
  const updateStep = useDictationChainStore((s) => s.updateStep);
  const updateStepInference = useDictationChainStore((s) => s.updateStepInference);
  const moveStep = useDictationChainStore((s) => s.moveStep);
  const removeStep = useDictationChainStore((s) => s.removeStep);
  const [open, setOpen] = useState(true);
  const problem = stepProblem(step);

  return (
    <SettingsPanel>
      <SettingsPanelRow>
        <div className="flex items-center gap-2">
          <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-primary/10 text-[10px] font-semibold text-primary">
            {index + 1}
          </span>
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className="min-w-0 flex-1 truncate text-start text-xs font-medium"
          >
            {step.name || t("settings.tab")}
            {problem && problem !== "disabled" && (
              <span className="ms-2 font-normal text-amber-600 dark:text-amber-400">
                · {t(`settings.problems.${problem}`)}
              </span>
            )}
          </button>
          <Toggle checked={step.enabled} onChange={(enabled) => updateStep(step.id, { enabled })} />
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 w-7 p-0"
            disabled={index === 0}
            onClick={() => moveStep(step.id, -1)}
            aria-label={t("settings.moveUp")}
            title={t("settings.moveUp")}
          >
            <ChevronUp className="h-3.5 w-3.5" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 w-7 p-0"
            disabled={index === count - 1}
            onClick={() => moveStep(step.id, 1)}
            aria-label={t("settings.moveDown")}
            title={t("settings.moveDown")}
          >
            <ChevronDown className="h-3.5 w-3.5" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 w-7 p-0 hover:text-destructive"
            onClick={() => removeStep(step.id)}
            aria-label={t("settings.remove")}
            title={t("settings.remove")}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      </SettingsPanelRow>
      {open && (
        <>
          <SettingsPanelRow>
            <div className="space-y-1.5">
              <p className="text-xs font-medium text-foreground">{t("settings.stepName")}</p>
              <Input
                value={step.name}
                onChange={(e) => updateStep(step.id, { name: e.target.value })}
                className="h-8 text-xs"
              />
            </div>
          </SettingsPanelRow>
          <SettingsPanelRow>
            <div className="space-y-1.5">
              <p className="text-xs font-medium text-foreground">{t("settings.stepPrompt")}</p>
              <p className="text-xs text-muted-foreground/80">{t("settings.stepPromptHelp")}</p>
              <Textarea
                value={step.prompt}
                onChange={(e) => updateStep(step.id, { prompt: e.target.value })}
                className="min-h-[96px] text-xs"
              />
            </div>
          </SettingsPanelRow>
          <SettingsPanelRow>
            <StepModelEditor
              inference={step.inference}
              onPatch={(patch) => updateStepInference(step.id, patch)}
            />
          </SettingsPanelRow>
          <SettingsPanelRow>
            <StepTester step={step} />
          </SettingsPanelRow>
        </>
      )}
    </SettingsPanel>
  );
}

export default function DictationChainSettings() {
  const { t } = useTranslation(DICTATION_CHAIN_NS);
  const enabled = useDictationChainStore((s) => s.enabled);
  const requireApproval = useDictationChainStore((s) => s.requireApproval);
  const steps = useDictationChainStore((s) => s.steps);
  const setEnabled = useDictationChainStore((s) => s.setEnabled);
  const setRequireApproval = useDictationChainStore((s) => s.setRequireApproval);
  const addStep = useDictationChainStore((s) => s.addStep);
  const useCleanupModel = useSettingsStore((s) => s.useCleanupModel);
  const runnable = runnableSteps({ enabled, requireApproval, steps }).length;

  return (
    <div className="space-y-4">
      <SectionHeader title={t("settings.title")} description={t("settings.description")} />
      <SettingsPanel>
        <SettingsPanelRow>
          <SettingsRow label={t("settings.enabled")} description={t("settings.enabledDescription")}>
            <Toggle checked={enabled} onChange={setEnabled} />
          </SettingsRow>
        </SettingsPanelRow>
        <SettingsPanelRow>
          <SettingsRow
            label={t("settings.requireApproval")}
            description={t("settings.requireApprovalDescription")}
          >
            <Toggle checked={requireApproval} onChange={setRequireApproval} />
          </SettingsRow>
        </SettingsPanelRow>
      </SettingsPanel>

      {enabled && !useCleanupModel && (
        <p className="text-xs text-muted-foreground">{t("settings.cleanupOffHint")}</p>
      )}
      {enabled && steps.length > 0 && runnable === 0 && (
        <p className="text-xs text-amber-600 dark:text-amber-400">
          {t("settings.noRunnableSteps")}
        </p>
      )}

      <div className="border-t border-border/70 pt-6">
        <div className="flex items-start justify-between gap-3">
          <SectionHeader title={t("settings.steps")} description={t("settings.stepsDescription")} />
          <Button type="button" variant="outline" size="sm" onClick={addStep}>
            <Plus className="h-3.5 w-3.5" />
            {t("settings.addStep")}
          </Button>
        </div>
        {steps.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t("settings.noSteps")}</p>
        ) : (
          <div className="space-y-3">
            {steps.map((step, index) => (
              <StepCard key={step.id} step={step} index={index} count={steps.length} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
