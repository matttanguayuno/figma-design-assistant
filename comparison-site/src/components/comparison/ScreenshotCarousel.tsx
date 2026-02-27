"use client";

import { useState } from "react";
import type { Screenshot } from "@/lib/comparisonData";

interface Props {
  screenshots: Screenshot[];
}

export default function ScreenshotCarousel({ screenshots }: Props) {
  const [idx, setIdx] = useState(0);

  if (!screenshots.length) return null;

  const current = screenshots[idx];

  return (
    <div className="mt-4">
      <div className="relative rounded-xl overflow-hidden border border-zinc-700/50 bg-zinc-950">
        <ImageWithFallback src={current.src} alt={current.alt} />

        {screenshots.length > 1 && (
          <>
            <button
              onClick={() => setIdx((i) => (i - 1 + screenshots.length) % screenshots.length)}
              className="absolute left-2 top-1/2 -translate-y-1/2 w-8 h-8 rounded-full bg-black/60 text-zinc-200 hover:bg-black/80 flex items-center justify-center text-lg"
              aria-label="Previous screenshot"
            >
              ‹
            </button>
            <button
              onClick={() => setIdx((i) => (i + 1) % screenshots.length)}
              className="absolute right-2 top-1/2 -translate-y-1/2 w-8 h-8 rounded-full bg-black/60 text-zinc-200 hover:bg-black/80 flex items-center justify-center text-lg"
              aria-label="Next screenshot"
            >
              ›
            </button>
          </>
        )}
      </div>

      {current.caption && (
        <p className="text-xs text-zinc-500 mt-2 text-center">{current.caption}</p>
      )}

      {screenshots.length > 1 && (
        <div className="flex justify-center gap-1.5 mt-2">
          {screenshots.map((_, i) => (
            <button
              key={i}
              onClick={() => setIdx(i)}
              className={`w-2 h-2 rounded-full transition-colors ${
                i === idx ? "bg-indigo-400" : "bg-zinc-600"
              }`}
              aria-label={`Go to screenshot ${i + 1}`}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/* ── Image with graceful fallback ────────────── */

function ImageWithFallback({ src, alt }: { src: string; alt: string }) {
  const [failed, setFailed] = useState(false);

  if (failed) {
    return (
      <div className="flex items-center justify-center h-48 bg-zinc-900 text-zinc-500 text-sm">
        <div className="text-center">
          <div className="text-3xl mb-2">🖼</div>
          <div>Screenshot placeholder</div>
          <div className="text-xs text-zinc-600 mt-1">{src}</div>
        </div>
      </div>
    );
  }

  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      alt={alt}
      className="w-full h-auto max-h-80 object-contain"
      onError={() => setFailed(true)}
    />
  );
}
