import ReasoningService from "./ReasoningService";
import logger from "../utils/logger";
import {
  buildRevisionRequest,
  revisionStep,
  wrapRevisionInput,
  buildStepRequest,
  cleanStepOutput,
  runnableSteps,
  wrapStepInput,
  REVIEW_TIMEOUT_MS,
  type DictationChainSettings,
  type DictationReviewResult,
  type ReviewStage,
} from "../config/dictationChain";

// A step may need the shared llama-server to load another model after cleanup
// used it; the user is waiting on the review either way, so allow for a swap.
const STEP_MODEL_BUSY_WAIT_MS = 10_000;

export interface ChainRunResult {
  /** The text after the last step that succeeded (the input when none did). */
  text: string;
  stages: ReviewStage[];
  failedSteps: number;
}

function errorMessage(error: unknown): string {
  if (error && typeof error === "object") {
    const e = error as { messageKey?: string; message?: string; code?: string };
    return e.message || e.code || "Step failed";
  }
  return String(error || "Step failed");
}

/**
 * Runs every runnable step in order. A failing step is reported in its stage
 * and skipped: the next step works on the last good text, so one broken model
 * never costs the dictation.
 */
export async function runDictationChain(
  input: string,
  settings: DictationChainSettings,
  agentName: string | null
): Promise<ChainRunResult> {
  const stages: ReviewStage[] = [];
  let current = input;
  let failedSteps = 0;

  for (const step of runnableSteps(settings)) {
    const { model, config } = buildStepRequest(step);
    const started = performance.now();
    try {
      const reply = await ReasoningService.processText(wrapStepInput(current), model, agentName, {
        ...config,
        busyWaitMs: STEP_MODEL_BUSY_WAIT_MS,
      });
      const output = cleanStepOutput(reply || "");
      if (!output) throw new Error("The model returned no text");
      current = output;
      stages.push({ label: step.name || "Rewrite", text: output });
      logger.info(
        "Rewrite chain step done",
        {
          mode: step.inference.mode,
          provider: config.provider,
          model,
          ms: Math.round(performance.now() - started),
          outputLength: output.length,
        },
        "reasoning"
      );
    } catch (error) {
      failedSteps += 1;
      const message = errorMessage(error);
      stages.push({ label: step.name || "Rewrite", text: current, error: message });
      logger.warn(
        "Rewrite chain step failed, keeping previous text",
        { mode: step.inference.mode, provider: config.provider, model, error: message },
        "reasoning"
      );
    }
  }

  return { text: current, stages, failedSteps };
}

/** Applies a spoken instruction to the current draft with the last step's model. */
export async function reviseDictation(
  draft: string,
  instruction: string,
  settings: DictationChainSettings,
  agentName: string | null
): Promise<string> {
  const step = revisionStep(settings);
  if (!step) throw new Error("No rewrite step is ready to revise with");
  const { model, config } = buildRevisionRequest(step);
  const reply = await ReasoningService.processText(
    wrapRevisionInput(draft, instruction),
    model,
    agentName,
    { ...config, busyWaitMs: STEP_MODEL_BUSY_WAIT_MS }
  );
  const revised = cleanStepOutput(reply || "")
    .replace(/^<draft>\s*/i, "")
    .replace(/\s*<\/draft>$/i, "")
    .trim();
  if (!revised) throw new Error("The model returned no text");
  return revised;
}

export async function requestDictationReview(
  stages: ReviewStage[],
  finalText: string
): Promise<DictationReviewResult> {
  const request = window.electronAPI?.requestDictationReview;
  if (!request) return { approved: true, reason: "unavailable" };
  try {
    return await request({ stages, finalText, timeoutMs: REVIEW_TIMEOUT_MS });
  } catch (error) {
    // A review window that can't open must not swallow the dictation: paste as usual.
    logger.warn("Dictation review unavailable", { error: errorMessage(error) }, "reasoning");
    return { approved: true, reason: "unavailable" };
  }
}

export interface AppliedChain {
  /** False when the chain is off or has no runnable step: deliver as usual. */
  ran: boolean;
  text: string;
  /** The review card was answered N (or timed out / was replaced): paste nothing. */
  rejected: boolean;
}

/**
 * Cleanup → rewrite steps → optional Y/N review. `cleanedText` is what the
 * dictation would paste today; `rawText` is the transcript before cleanup.
 */
export async function applyDictationChain(
  cleanedText: string,
  rawText: string,
  settings: DictationChainSettings,
  agentName: string | null,
  { onReviewOpen }: { onReviewOpen?: () => void } = {}
): Promise<AppliedChain> {
  if (!settings.enabled || runnableSteps(settings).length === 0) {
    return { ran: false, text: cleanedText, rejected: false };
  }

  const run = await runDictationChain(cleanedText, settings, agentName);
  if (!settings.requireApproval) {
    return { ran: true, text: run.text, rejected: false };
  }

  const stages: ReviewStage[] = [{ label: "Original", text: rawText }];
  if (cleanedText.trim() !== rawText.trim()) stages.push({ label: "Cleanup", text: cleanedText });
  stages.push(...run.stages);

  onReviewOpen?.();
  const review = await requestDictationReview(stages, run.text);
  const text = typeof review.text === "string" && review.text.trim() ? review.text : run.text;
  return { ran: true, text, rejected: !review.approved };
}
