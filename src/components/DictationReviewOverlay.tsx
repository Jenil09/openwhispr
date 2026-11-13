import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { DICTATION_CHAIN_NS } from "../config/dictationChainI18n";
import type {
  DictationReviewKeyAction,
  DictationReviewRequest,
  ReviewStage,
} from "../config/dictationChain";
import { readDictationChainSettings } from "../stores/dictationChainStore";
import { reviseDictation } from "../services/dictationChain";
import { getAgentName } from "../utils/agentName";
import { useVoiceDraft } from "./chat/useVoiceDraft";
import { cn } from "./lib/utils";

type ReviewData = DictationReviewRequest & { deadline: number };

function useTransparentPage() {
  useEffect(() => {
    const targets = [document.documentElement, document.body, document.getElementById("root")];
    for (const el of targets) {
      if (!el) continue;
      el.style.background = "transparent";
      el.style.overflow = "hidden";
    }
  }, []);
}

function useSecondsLeft(deadline: number | null, paused: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!deadline || paused) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(timer);
  }, [deadline, paused]);
  return deadline ? Math.max(0, Math.ceil((deadline - now) / 1000)) : 0;
}

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="inline-flex h-5 min-w-5 items-center justify-center rounded border border-border/80 bg-muted/70 px-1 font-mono text-[10px] font-medium text-muted-foreground">
      {children}
    </kbd>
  );
}

export default function DictationReviewOverlay() {
  useTransparentPage();
  const { t } = useTranslation(DICTATION_CHAIN_NS);
  const [data, setData] = useState<ReviewData | null>(null);
  // The card's own copy: R revisions change the text and add stages.
  const [draft, setDraft] = useState("");
  const [stages, setStages] = useState<ReviewStage[]>([]);
  const [deadline, setDeadline] = useState<number | null>(null);
  const [revising, setRevising] = useState(false);
  const [revisionError, setRevisionError] = useState<string | null>(null);
  const [showSteps, setShowSteps] = useState(false);
  const cardRef = useRef<HTMLDivElement>(null);
  // Moves on with every new review or cancel, so a late revision is dropped.
  const revisionTokenRef = useRef(0);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const dataRef = useRef(data);
  dataRef.current = data;

  const extend = useCallback(async () => {
    const id = dataRef.current?.id;
    if (!id) return;
    const next = await window.electronAPI?.extendDictationReview?.(id);
    if (next && dataRef.current?.id === id) setDeadline(next);
  }, []);

  const applyInstruction = useCallback(
    async (instruction: string) => {
      const reviewId = dataRef.current?.id;
      if (!reviewId) return;
      const token = ++revisionTokenRef.current;
      setRevising(true);
      setRevisionError(null);
      try {
        const revised = await reviseDictation(
          draftRef.current,
          instruction,
          readDictationChainSettings(),
          getAgentName() || null
        );
        if (token !== revisionTokenRef.current || dataRef.current?.id !== reviewId) return;
        setDraft(revised);
        setStages((prev) => [
          ...prev,
          { label: t("review.revisionLabel", { instruction }), text: revised },
        ]);
      } catch (error) {
        if (token !== revisionTokenRef.current) return;
        setRevisionError(error instanceof Error ? error.message : String(error));
      } finally {
        if (token === revisionTokenRef.current) {
          setRevising(false);
          void extend();
        }
      }
    },
    [extend, t]
  );

  const voice = useVoiceDraft({
    onTranscript: (text) => void applyInstruction(text),
    onError: (message) => {
      setRevisionError(message || t("review.voiceFailed"));
      void extend();
    },
    onEmpty: () => {
      setRevisionError(t("review.voiceEmpty"));
      void extend();
    },
  });
  const listening = voice.status === "recording";
  const busy = listening || voice.status === "transcribing" || revising;
  const secondsLeft = useSecondsLeft(deadline, busy);

  const reset = useCallback((next: ReviewData | null) => {
    revisionTokenRef.current += 1;
    setData(next);
    setDraft(next?.finalText ?? "");
    setStages(next?.stages ?? []);
    setDeadline(next?.deadline ?? null);
    setRevising(false);
    setRevisionError(null);
    setShowSteps(false);
  }, []);

  useEffect(() => {
    let alive = true;
    void window.electronAPI?.getDictationReviewData?.().then((initial) => {
      if (alive && initial) reset(initial);
    });
    const dispose = window.electronAPI?.onDictationReviewData?.((payload) => reset(payload));
    return () => {
      alive = false;
      dispose?.();
    };
  }, [reset]);

  // A settled or replaced review drops any take still running.
  const cancelVoice = voice.cancel;
  useEffect(() => {
    cancelVoice();
  }, [data?.id, cancelVoice]);

  const respond = useCallback((approved: boolean) => {
    const current = dataRef.current;
    if (!current) return;
    void window.electronAPI?.respondDictationReview?.(current.id, approved, draftRef.current);
  }, []);

  const startRevision = useCallback(async () => {
    if (busy) return;
    setRevisionError(null);
    if (voice.streamingOnlyProvider) {
      setRevisionError(t("review.voiceUnsupported"));
      return;
    }
    void extend();
    const started = await voice.start();
    if (!started) setRevisionError((prev) => prev ?? t("review.voiceFailed"));
  }, [busy, extend, t, voice]);

  const cancelRevision = useCallback(() => {
    revisionTokenRef.current += 1;
    voice.cancel();
    setRevising(false);
    void extend();
  }, [extend, voice]);

  // Keys arrive from main's global shortcuts; their meaning depends on the phase.
  const handleKey = useCallback(
    (action: DictationReviewKeyAction) => {
      if (listening) {
        if (action === "revise" || action === "enter") voice.stop();
        else if (action === "escape") cancelRevision();
        return;
      }
      if (busy) {
        if (action === "escape") cancelRevision();
        return;
      }
      if (action === "approve" || action === "enter") respond(true);
      else if (action === "reject" || action === "escape") respond(false);
      else if (action === "revise") void startRevision();
    },
    [busy, cancelRevision, listening, respond, startRevision, voice]
  );
  const handleKeyRef = useRef(handleKey);
  handleKeyRef.current = handleKey;

  useEffect(
    () =>
      window.electronAPI?.onDictationReviewKey?.(({ id, action }) => {
        if (dataRef.current?.id === id) handleKeyRef.current(action);
      }),
    []
  );

  // Report the card's height so main sizes the window to it, then reveals it.
  useLayoutEffect(() => {
    const el = cardRef.current;
    if (!data || !el) return;
    const report = () => {
      // The wrapper's padding leaves room for the card's shadow.
      void window.electronAPI?.resizeDictationReview?.(data.id, el.offsetHeight + 24);
    };
    report();
    const observer = new ResizeObserver(report);
    observer.observe(el);
    return () => observer.disconnect();
  }, [data]);

  if (!data) return <div className="dictation-review-window" />;

  const original = stages[0];
  const steps = stages.slice(1);
  const failed = steps.filter((stage) => stage.error).length;
  const unchanged = original && original.text.trim() === draft.trim();

  let status: React.ReactNode = null;
  if (listening) {
    status = (
      <div className="flex items-center gap-2 rounded-lg bg-red-500/10 px-2.5 py-1.5 text-[12px] text-red-600 dark:text-red-400">
        <span className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-red-500" />
        <span className="flex-1">{t("review.listening")}</span>
        <span className="tabular-nums">{voice.elapsed}s</span>
      </div>
    );
  } else if (voice.status === "transcribing" || revising) {
    status = (
      <div className="flex items-center gap-2 rounded-lg bg-primary/10 px-2.5 py-1.5 text-[12px] text-primary">
        <span className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-primary" />
        {t(revising ? "review.revising" : "review.transcribing")}
      </div>
    );
  } else if (revisionError) {
    status = (
      <p className="text-[11px] text-destructive">
        {t("review.revisionFailed", { error: revisionError })}
      </p>
    );
  }

  return (
    <div className="dictation-review-window w-full select-none p-3">
      <div
        ref={cardRef}
        className="overflow-hidden rounded-2xl border border-white/15 bg-background/80 text-foreground shadow-[0_8px_32px_rgba(0,0,0,0.28)] backdrop-blur-2xl backdrop-saturate-150 dark:border-white/10"
      >
        <div className="flex items-center justify-between gap-3 px-4 pt-3 pb-2">
          <p className="text-[13px] font-semibold">{t("review.title")}</p>
          <p className="text-[11px] tabular-nums text-muted-foreground">
            {busy ? t("review.paused") : t("review.countdown", { seconds: secondsLeft })}
          </p>
        </div>

        <div className="space-y-2 px-4">
          {original && (
            <section>
              <p className="mb-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                {t("review.original")}
              </p>
              <p className="max-h-24 overflow-y-auto whitespace-pre-wrap text-[13px] leading-snug text-muted-foreground">
                {original.text}
              </p>
            </section>
          )}
          <div className="flex items-center gap-2 text-muted-foreground/70" aria-hidden="true">
            <div className="h-px flex-1 bg-border/70" />
            <span className="text-xs">↓</span>
            <div className="h-px flex-1 bg-border/70" />
          </div>
          <section>
            <p className="mb-0.5 text-[10px] font-medium uppercase tracking-wide text-primary">
              {t("review.result")}
            </p>
            <p
              className={cn(
                "max-h-72 overflow-y-auto whitespace-pre-wrap rounded-lg bg-primary/[0.07] px-2.5 py-2 text-sm leading-relaxed transition-opacity",
                unchanged && "text-muted-foreground",
                (revising || voice.status === "transcribing") && "opacity-60"
              )}
            >
              {draft}
            </p>
          </section>

          {status}

          {failed > 0 && (
            <p className="text-[11px] text-destructive">
              {t("review.someFailed", { count: failed })}
            </p>
          )}

          {steps.length > 0 && (
            <div>
              <button
                type="button"
                onClick={() => setShowSteps((v) => !v)}
                className="text-[11px] text-muted-foreground underline-offset-2 hover:underline"
              >
                {showSteps ? "▾" : "▸"} {t("review.steps")} ({steps.length})
              </button>
              {showSteps && (
                <ol className="mt-1 max-h-48 space-y-1.5 overflow-y-auto border-s border-border/70 ps-2.5">
                  {steps.map((stage, index) => (
                    <li key={index} className="text-[12px] leading-snug">
                      <span className="font-medium">{stage.label}</span>
                      {stage.error ? (
                        <p className="text-destructive">
                          {t("review.stepFailed", { error: stage.error })}
                        </p>
                      ) : (
                        <p className="whitespace-pre-wrap text-muted-foreground">{stage.text}</p>
                      )}
                    </li>
                  ))}
                </ol>
              )}
            </div>
          )}
        </div>

        <div className="mt-3 flex items-center justify-between gap-3 border-t border-border/60 bg-muted/20 px-4 py-2.5">
          <p className="text-[11px] text-muted-foreground">
            {listening ? t("review.listeningHint") : t("review.keysHint")}
          </p>
          <div className="ms-auto flex items-center gap-2">
            {listening ? (
              <button
                type="button"
                onClick={() => voice.stop()}
                className="inline-flex items-center gap-1.5 rounded-lg bg-red-500 px-2.5 py-1 text-xs font-medium text-white hover:bg-red-500/90"
              >
                <Kbd>R</Kbd>
                {t("review.finishRevision")}
              </button>
            ) : (
              <>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void startRevision()}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-border/80 bg-background/60 px-2.5 py-1 text-xs font-medium hover:bg-muted disabled:opacity-50"
                >
                  <Kbd>R</Kbd>
                  {t("review.revise")}
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => respond(false)}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-border/80 bg-background/60 px-2.5 py-1 text-xs font-medium hover:bg-muted disabled:opacity-50"
                >
                  <Kbd>N</Kbd>
                  {t("review.reject")}
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => respond(true)}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
                >
                  <Kbd>Y</Kbd>
                  {t("review.approve")}
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
