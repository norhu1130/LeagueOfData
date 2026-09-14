import { PRESET_REGIONS, type RegionShape } from '@lol/data-model';
import { useState } from 'react';

const VIEW = 1000;

/**
 * Converts normalized coordinates to SVG coordinates. This is the only y-axis flip.
 * It follows `toScreen`, while the SVG viewBox absorbs display-size changes.
 */
const sx = (xNorm: number) => xNorm * VIEW;
const sy = (yNorm: number) => (1 - yNorm) * VIEW;

function ShapePath({ shape }: { shape: RegionShape }) {
  switch (shape.kind) {
    case 'polygon':
      return <polygon points={shape.points.map(([x, y]) => `${sx(x)},${sy(y)}`).join(' ')} />;
    case 'rect': {
      const x0 = Math.min(shape.x0, shape.x1);
      const y1 = Math.max(shape.y0, shape.y1);
      return (
        <rect
          x={sx(x0)}
          y={sy(y1)}
          width={Math.abs(shape.x1 - shape.x0) * VIEW}
          height={Math.abs(shape.y1 - shape.y0) * VIEW}
        />
      );
    }
    case 'circle':
      return <circle cx={sx(shape.cx)} cy={sy(shape.cy)} r={shape.r * VIEW} />;
    case 'multi':
      return (
        <>
          {shape.parts.map((p, i) => (
            <ShapePath key={i} shape={p} />
          ))}
        </>
      );
  }
}

export function MinimapPreview() {
  const [hovered, setHovered] = useState<string | null>(null);

  return (
    <section>
      <h2 className="mb-2 text-sm font-medium text-neutral-300">
        미니맵 좌표 확인 {hovered && <span className="text-neutral-500">— {hovered}</span>}
      </h2>
      <svg
        viewBox={`0 0 ${VIEW} ${VIEW}`}
        className="h-96 w-96 rounded border border-neutral-800 bg-neutral-900"
      >
        {/* 블루 본진이 좌하단에 와야 좌표계가 맞는 것이다 */}
        <text x={20} y={980} className="fill-blue-500 text-[32px]">
          블루
        </text>
        <text x={840} y={48} className="fill-red-500 text-[32px]">
          레드
        </text>
        {PRESET_REGIONS.map((r) => (
          <g
            key={r.id}
            onMouseEnter={() => setHovered(r.label)}
            onMouseLeave={() => setHovered(null)}
            className={
              hovered === r.label
                ? 'fill-sky-400/30 stroke-sky-300'
                : 'fill-neutral-100/5 stroke-neutral-700'
            }
            strokeWidth={2}
          >
            <ShapePath shape={r.shape} />
          </g>
        ))}
      </svg>
    </section>
  );
}
