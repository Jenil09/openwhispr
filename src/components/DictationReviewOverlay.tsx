import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { DICTATION_CHAIN_NS } from "../config/dictationChainI18n";
import type { DictationReviewRequest } from "../config/dictationChain";
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

function useSecondsLeft(deadline: number | null) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!deadline) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(timer);
  }, [deadline]);
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
  const [showSteps, setShowSteps] = useState(false);
  const cardRef = useRef<HTMLDivElement>(null);
  const secondsLeft = useSecondsLeft(data?.deadline ?? null);

  useEffect(() => {
    let alive = true;
    void window.electronAPI?.getDictationReviewData?.().then((initial) => {
      if (alive && initial) setData(initial);
    });
    const dispose = window.electronAPI?.onDictationReviewData?.((payload) => {
      setShowSteps(false);
      setData(payload);
    });
    return () => {
      alive = false;
      dispose?.();
    };
  }, []);

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
  }, [data, showSteps]);

  const respond = useCallback(
    (approved: boolean) => {
      if (data) void window.electronAPI?.respondDictationReview?.(data.id, approved);
    },
    [data]
  );

  if (!data) return <div className="dictation-review-window" />;

  const original = data.stages[0];
  const steps = data.stages.slice(1);
  const failed = steps.filter((stage) => stage.error).length;
  const unchanged = original && original.text.trim() === data.finalText.trim();

  return (
    <div className="dictation-review-window w-full select-none p-3">
      <div
        ref={cardRef}
        className="overflow-hidden rounded-2xl border border-white/15 bg-background/75 text-foreground shadow-[0_8px_32px_rgba(0,0,0,0.28)] backdrop-blur-2xl backdrop-saturate-150 dark:border-white/10"
      >
        <div className="flex items-center justify-between gap-3 px-4 pt-3 pb-2">
          <p className="text-[13px] font-semibold">{t("review.title")}</p>
          <p className="text-[11px] tabular-nums text-muted-foreground">
            {t("review.countdown", { seconds: secondsLeft })}
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
                "max-h-60 overflow-y-auto whitespace-pre-wrap rounded-lg bg-primary/[0.07] px-2.5 py-2 text-sm leading-relaxed",
                unchanged && "text-muted-foreground"
              )}
            >
              {data.finalText}
            </p>
          </section>

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
          <p className="text-[11px] text-muted-foreground">{t("review.keysHint")}</p>
          <div className="ms-auto flex items-center gap-2">
            <button
              type="button"
              onClick={() => respond(false)}
              className="inline-flex items-center gap-1.5 rounded-lg border border-border/80 bg-background/60 px-2.5 py-1 text-xs font-medium hover:bg-muted"
            >
              <Kbd>N</Kbd>
              {t("review.reject")}
            </button>
            <button
              type="button"
              onClick={() => respond(true)}
              className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground hover:bg-primary/90"
            >
              <Kbd>Y</Kbd>
              {t("review.approve")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
