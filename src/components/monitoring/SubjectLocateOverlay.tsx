import { useEffect, useRef, useState } from "react";
import { objectCoverRect, type Size } from "@/lib/object-cover";
import type { NormalizedBox } from "@/lib/subject-locate";

/**
 * Draws ONE highlight around an anonymous subject that the AI service proved is
 * currently observed. Geometry is derived from the real displayed image, so the
 * marker matches the cropped `object-cover` stream instead of pointing at an
 * approximate position. Nothing is drawn until both sizes are known.
 */
export function SubjectLocateOverlay({
  box,
  label,
  image,
}: {
  box: NormalizedBox;
  label: string;
  image: Size | null;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [container, setContainer] = useState<Size | null>(null);

  useEffect(() => {
    const node = hostRef.current;
    if (!node) return;
    const measure = () =>
      setContainer({ width: node.clientWidth, height: node.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const rect = objectCoverRect(box, image, container);
  return (
    <div ref={hostRef} className="pointer-events-none absolute inset-0 z-30">
      {rect && (
        <div
          className="absolute animate-pulse border-2 border-warning"
          style={{
            left: `${rect.left}px`,
            top: `${rect.top}px`,
            width: `${rect.width}px`,
            height: `${rect.height}px`,
          }}
        >
          <span className="absolute -top-5 left-0 bg-warning px-1 font-mono text-[9px] text-background">
            {label}
          </span>
        </div>
      )}
    </div>
  );
}
