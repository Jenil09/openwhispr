import { create } from "zustand";
import {
  createStep,
  normalizeChainSettings,
  DEFAULT_CHAIN_SETTINGS,
  type ChainStep,
  type ChainStepInference,
  type DictationChainSettings,
} from "../config/dictationChain";

// Kept apart from settingsStore so the fork's feature never conflicts with
// upstream changes to that file. One JSON blob in localStorage; the dictation
// window picks up Control Panel edits through the `storage` event.
const STORAGE_KEY = "dictationChain";

const isBrowser = typeof window !== "undefined" && typeof localStorage !== "undefined";

function read(): DictationChainSettings {
  if (!isBrowser) return { ...DEFAULT_CHAIN_SETTINGS };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? normalizeChainSettings(JSON.parse(raw)) : { ...DEFAULT_CHAIN_SETTINGS };
  } catch {
    return { ...DEFAULT_CHAIN_SETTINGS };
  }
}

function write(settings: DictationChainSettings): void {
  if (!isBrowser) return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Storage full or blocked: the in-memory copy still applies this session.
  }
}

interface DictationChainState extends DictationChainSettings {
  setEnabled: (enabled: boolean) => void;
  setRequireApproval: (value: boolean) => void;
  addStep: () => void;
  removeStep: (id: string) => void;
  moveStep: (id: string, direction: -1 | 1) => void;
  updateStep: (id: string, patch: Partial<Omit<ChainStep, "id" | "inference">>) => void;
  updateStepInference: (id: string, patch: Partial<ChainStepInference>) => void;
}

const snapshot = (s: DictationChainSettings): DictationChainSettings => ({
  enabled: s.enabled,
  requireApproval: s.requireApproval,
  steps: s.steps,
});

export const useDictationChainStore = create<DictationChainState>()((set, get) => {
  const commit = (patch: Partial<DictationChainSettings>) => {
    set(patch);
    write(snapshot(get()));
  };
  const mapSteps = (fn: (steps: ChainStep[]) => ChainStep[]) => commit({ steps: fn(get().steps) });

  return {
    ...read(),
    setEnabled: (enabled) => commit({ enabled }),
    setRequireApproval: (requireApproval) => commit({ requireApproval }),
    addStep: () =>
      mapSteps((steps) => {
        // A new step starts on the previous step's model, the common case.
        const previous = steps[steps.length - 1];
        return [
          ...steps,
          createStep({
            name: `Rewrite ${steps.length + 1}`,
            ...(previous ? { inference: { ...previous.inference } } : {}),
          }),
        ];
      }),
    removeStep: (id) => mapSteps((steps) => steps.filter((step) => step.id !== id)),
    moveStep: (id, direction) =>
      mapSteps((steps) => {
        const index = steps.findIndex((step) => step.id === id);
        const target = index + direction;
        if (index < 0 || target < 0 || target >= steps.length) return steps;
        const next = [...steps];
        [next[index], next[target]] = [next[target], next[index]];
        return next;
      }),
    updateStep: (id, patch) =>
      mapSteps((steps) => steps.map((step) => (step.id === id ? { ...step, ...patch } : step))),
    updateStepInference: (id, patch) =>
      mapSteps((steps) =>
        steps.map((step) =>
          step.id === id ? { ...step, inference: { ...step.inference, ...patch } } : step
        )
      ),
  };
});

/** Straight from storage, for windows that may have missed a change event. */
export function readDictationChainSettings(): DictationChainSettings {
  return read();
}

export function getDictationChainSettings(): DictationChainSettings {
  return snapshot(useDictationChainStore.getState());
}

if (isBrowser) {
  window.addEventListener("storage", (event) => {
    if (event.key !== STORAGE_KEY || event.storageArea !== localStorage) return;
    useDictationChainStore.setState(read());
  });
}
