import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import { TOUR_STEPS } from "./tour-steps.js";

interface Box {
  top: number;
  left: number;
  width: number;
  height: number;
}

const PADDING = 8;
const CARD_WIDTH = 380;
const GAP = 14;

function targetBox(target: string): Box | undefined {
  const element = document.querySelector(`[data-tour="${target}"]`);
  if (!element) return undefined;
  const rect = element.getBoundingClientRect();
  return {
    top: rect.top - PADDING,
    left: rect.left - PADDING,
    width: rect.width + PADDING * 2,
    height: rect.height + PADDING * 2
  };
}

function cardPosition(box: Box | undefined, cardHeight: number): React.CSSProperties {
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  // Phones and missing targets: a sheet pinned to the bottom / centre is easier to read.
  if (!box) return { left: "50%", top: "50%", transform: "translate(-50%, -50%)" };
  if (viewportWidth < 640) return { left: 12, right: 12, bottom: 12 };
  const left = Math.min(Math.max(12, box.left), viewportWidth - CARD_WIDTH - 12);
  const below = box.top + box.height + GAP;
  if (below + cardHeight < viewportHeight - 12) return { left, top: below };
  const above = box.top - GAP - cardHeight;
  if (above > 12) return { left, top: above };
  return { left, top: Math.max(12, viewportHeight - cardHeight - 12) };
}

export function Tour({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [index, setIndex] = useState(0);
  const [box, setBox] = useState<Box>();
  const [cardHeight, setCardHeight] = useState(240);
  const card = useRef<HTMLDivElement>(null);
  const step = TOUR_STEPS[index]!;
  const last = index === TOUR_STEPS.length - 1;

  useEffect(() => {
    if (open) setIndex(0);
  }, [open]);

  // Bring the highlighted element into view, then follow it while the page scrolls or resizes.
  useEffect(() => {
    if (!open) return;
    const element = document.querySelector(`[data-tour="${step.target}"]`);
    // A step inside a collapsed section ("Тонкая настройка") opens it first.
    const details = element?.closest("details");
    if (details) details.open = true;
    element?.scrollIntoView({ block: "center", behavior: "smooth" });
    let frame = 0;
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => setBox(targetBox(step.target)));
    };
    update();
    const settle = window.setTimeout(update, 400);
    window.addEventListener("scroll", update, true);
    window.addEventListener("resize", update);
    return () => {
      cancelAnimationFrame(frame);
      window.clearTimeout(settle);
      window.removeEventListener("scroll", update, true);
      window.removeEventListener("resize", update);
    };
  }, [open, step.target]);

  useLayoutEffect(() => {
    if (!open || !card.current) return;
    setCardHeight(card.current.offsetHeight);
    card.current.focus();
  }, [open, index]);

  const next = useCallback(
    () => (last ? onClose() : setIndex((value) => value + 1)),
    [last, onClose]
  );
  const back = useCallback(() => setIndex((value) => Math.max(0, value - 1)), []);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
      else if (event.key === "ArrowRight") next();
      else if (event.key === "ArrowLeft") back();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, next, back, onClose]);

  if (!open) return null;
  return (
    <div className="tour" aria-live="polite">
      {box ? (
        <div
          className="tour-spotlight"
          style={{ top: box.top, left: box.left, width: box.width, height: box.height }}
        />
      ) : (
        <div className="tour-backdrop" />
      )}
      <div
        ref={card}
        className="tour-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="tour-title"
        tabIndex={-1}
        style={cardPosition(box, cardHeight)}
      >
        <p className="label">
          ТУР · {index + 1} / {TOUR_STEPS.length}
        </p>
        <h2 id="tour-title">{step.title}</h2>
        <TourBody paragraphs={step.body} />
        <div className="tour-progress" aria-hidden>
          {TOUR_STEPS.map((item, position) => (
            <i key={item.target} className={position <= index ? "done" : ""} />
          ))}
        </div>
        <div className="tour-actions">
          <button className="text-link" onClick={onClose}>
            {last ? "Закрыть" : "Пропустить"}
          </button>
          <span>
            {index > 0 && (
              <button className="button secondary" onClick={back}>
                Назад
              </button>
            )}
            <button className="button primary" onClick={next}>
              {last ? "Готово" : "Далее"}
            </button>
          </span>
        </div>
      </div>
    </div>
  );
}

function TourBody({ paragraphs }: { paragraphs: string[] }) {
  const blocks: React.ReactNode[] = [];
  let list: string[] = [];
  const flush = () => {
    if (!list.length) return;
    blocks.push(
      <ol key={`list-${String(blocks.length)}`}>
        {list.map((item) => (
          <li key={item}>{item.replace(/^\d+\.\s*/u, "")}</li>
        ))}
      </ol>
    );
    list = [];
  };
  for (const paragraph of paragraphs) {
    if (/^\d+\.\s/u.test(paragraph)) list.push(paragraph);
    else {
      flush();
      blocks.push(<p key={paragraph}>{paragraph}</p>);
    }
  }
  flush();
  return <div className="tour-body">{blocks}</div>;
}
