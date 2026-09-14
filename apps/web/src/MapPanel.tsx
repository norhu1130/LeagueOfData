import type { NormXY, RegionDefinition, RegionShape } from '@lol/data-model';
import {
  initialMapEditorState,
  mapEditorReducer,
  type MapEditorAction,
  type MapEditorState,
} from '@lol/map-editor';
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
} from 'react';

function screenPoint([x, y]: NormXY): string {
  return `${x * 1000},${(1 - y) * 1000}`;
}

const INITIAL_KEYBOARD_CURSOR: NormXY = [0.5, 0.5];
const SUMMONERS_RIFT_MAP_URL = '/assets/summoners-rift-map-16.17.1.png';

export function moveKeyboardCursor(
  cursor: NormXY,
  key: string,
  useLargeStep: boolean,
): NormXY | null {
  const direction: Partial<Record<string, NormXY>> = {
    ArrowLeft: [-1, 0],
    ArrowRight: [1, 0],
    ArrowDown: [0, -1],
    ArrowUp: [0, 1],
  };
  const movement = direction[key];
  if (!movement) return null;
  const step = useLargeStep ? 0.05 : 0.01;
  return [
    Math.max(0, Math.min(1, cursor[0] + movement[0] * step)),
    Math.max(0, Math.min(1, cursor[1] + movement[1] * step)),
  ];
}

export function heatmapSampleLabelKo(displayed: number, total?: number): string {
  const displayedLabel = displayed.toLocaleString('ko-KR');
  if (total !== undefined)
    return `전체 ${total.toLocaleString('ko-KR')}개 중 화면에 표시한 위치 표본 ${displayedLabel}개`;
  return `화면에 표시한 위치 표본 ${displayedLabel}개 (서버 응답에 포함된 표본 기준)`;
}

function clientPointToNorm(svg: SVGSVGElement, clientX: number, clientY: number): NormXY {
  const matrix = svg.getScreenCTM();
  if (matrix) {
    const point = new DOMPoint(clientX, clientY).matrixTransform(matrix.inverse());
    return [Math.max(0, Math.min(1, point.x / 1000)), Math.max(0, Math.min(1, 1 - point.y / 1000))];
  }
  const rect = svg.getBoundingClientRect();
  return [
    Math.max(0, Math.min(1, (clientX - rect.left) / rect.width)),
    Math.max(0, Math.min(1, 1 - (clientY - rect.top) / rect.height)),
  ];
}

function Shape({ shape, className }: { shape: RegionShape; className: string }) {
  if (shape.kind === 'polygon')
    return <polygon className={className} points={shape.points.map(screenPoint).join(' ')} />;
  if (shape.kind === 'rect')
    return (
      <rect
        className={className}
        x={Math.min(shape.x0, shape.x1) * 1000}
        y={(1 - Math.max(shape.y0, shape.y1)) * 1000}
        width={Math.abs(shape.x1 - shape.x0) * 1000}
        height={Math.abs(shape.y1 - shape.y0) * 1000}
      />
    );
  if (shape.kind === 'circle')
    return (
      <circle
        className={className}
        cx={shape.cx * 1000}
        cy={(1 - shape.cy) * 1000}
        r={shape.r * 1000}
      />
    );
  return shape.parts.map((part, index) => <Shape key={index} shape={part} className={className} />);
}

function HeatmapCanvas({ points }: { points: readonly { x_norm: number; y_norm: number }[] }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const context = canvas.current?.getContext('2d');
    if (!context) return;
    context.clearRect(0, 0, 1000, 1000);
    context.globalCompositeOperation = 'lighter';
    const samples: Array<{ x: number; y: number; weight: number }> = [];
    if (points.length <= 5_000) {
      for (const point of points) {
        if (!Number.isFinite(point.x_norm) || !Number.isFinite(point.y_norm)) continue;
        samples.push({ x: point.x_norm * 1000, y: (1 - point.y_norm) * 1000, weight: 1 });
      }
    } else {
      // Large map results are binned before painting so gradient allocation stays bounded.
      const gridSize = 64;
      const bins = new Uint32Array(gridSize * gridSize);
      let maximum = 1;
      for (const point of points) {
        if (!Number.isFinite(point.x_norm) || !Number.isFinite(point.y_norm)) continue;
        const x = Math.max(0, Math.min(gridSize - 1, Math.floor(point.x_norm * gridSize)));
        const y = Math.max(0, Math.min(gridSize - 1, Math.floor((1 - point.y_norm) * gridSize)));
        const index = y * gridSize + x;
        const count = (bins[index] ?? 0) + 1;
        bins[index] = count;
        maximum = Math.max(maximum, count);
      }
      for (let index = 0; index < bins.length; index++) {
        const count = bins[index]!;
        if (!count) continue;
        samples.push({
          x: ((index % gridSize) + 0.5) * (1000 / gridSize),
          y: (Math.floor(index / gridSize) + 0.5) * (1000 / gridSize),
          weight: count / maximum,
        });
      }
    }
    for (const point of samples) {
      const x = point.x;
      const y = point.y;
      const gradient = context.createRadialGradient(x, y, 0, x, y, 38);
      gradient.addColorStop(0, `rgba(224, 68, 44, ${Math.min(0.65, 0.16 + point.weight * 0.4)})`);
      gradient.addColorStop(1, 'rgba(224, 68, 44, 0)');
      context.fillStyle = gradient;
      context.fillRect(x - 38, y - 38, 76, 76);
    }
    context.globalCompositeOperation = 'source-over';
  }, [points]);
  return (
    <canvas
      ref={canvas}
      className="minimap-heatmap"
      width="1000"
      height="1000"
      aria-hidden="true"
    />
  );
}

export function MapPanel({
  regions,
  activeRegionId,
  onSave,
  onDelete,
  heatmapPoints = [],
  heatmapTotal,
}: {
  regions: readonly RegionDefinition[];
  activeRegionId: string | null;
  onSave: (region: RegionDefinition) => void;
  onDelete: (region: RegionDefinition) => void;
  heatmapPoints?: readonly { x_norm: number; y_norm: number }[];
  heatmapTotal?: number;
}) {
  const [state, setState] = useState<MapEditorState>(initialMapEditorState);
  const [id, setId] = useState('my_region');
  const [label, setLabel] = useState('내 영역');
  const [keyboardCursor, setKeyboardCursor] = useState<NormXY>(INITIAL_KEYBOARD_CURSOR);
  const [liveMessage, setLiveMessage] = useState('');
  const mapSvg = useRef<SVGSVGElement>(null);
  const displayableHeatmapPoints = useMemo(
    () =>
      heatmapPoints.filter(
        (point) => Number.isFinite(point.x_norm) && Number.isFinite(point.y_norm),
      ),
    [heatmapPoints],
  );
  const send = (action: MapEditorAction) =>
    setState((current) => mapEditorReducer(current, action));
  const addPoint = (event: MouseEvent<SVGSVGElement>) => {
    if (state.mode !== 'drawing') return;
    const point = clientPointToNorm(event.currentTarget, event.clientX, event.clientY);
    send({
      type: 'addPoint',
      point,
    });
    setKeyboardCursor(point);
    setLiveMessage(`${state.points.length + 1}번째 꼭짓점을 추가했습니다.`);
  };
  const startDrawing = () => {
    setKeyboardCursor(INITIAL_KEYBOARD_CURSOR);
    setLiveMessage('그리기를 시작했습니다. 화살표 키로 커서를 이동하세요.');
    send({ type: 'startDrawing' });
    window.requestAnimationFrame(() => mapSvg.current?.focus());
  };
  useEffect(() => {
    if (state.mode === 'drawing') mapSvg.current?.focus();
  }, [state.mode]);
  const save = () => {
    const next = mapEditorReducer(state, { type: 'save', id, label });
    setState(next);
    if (next.draft) onSave(next.draft);
  };
  const pointerPoint = (event: PointerEvent<SVGCircleElement>): NormXY => {
    const svg = event.currentTarget.ownerSVGElement!;
    return clientPointToNorm(svg, event.clientX, event.clientY);
  };
  const finishDrag = () => {
    const next = mapEditorReducer(state, { type: 'dragEnd' });
    setState(next);
    if (next.draft && !next.warningKo) onSave(next.draft);
  };
  const selectRegion = (region: RegionDefinition) => send({ type: 'select', region });
  const selectRegionWithKeyboard = (
    event: KeyboardEvent<SVGGElement>,
    region: RegionDefinition,
  ) => {
    if (state.mode === 'drawing' || (event.key !== 'Enter' && event.key !== ' ')) return;
    event.preventDefault();
    event.stopPropagation();
    selectRegion(region);
  };
  const moveVertexWithKeyboard = (event: KeyboardEvent<SVGCircleElement>, index: number) => {
    const point = moveKeyboardCursor(state.points[index]!, event.key, event.shiftKey);
    if (state.mode !== 'editing' || !point) return;
    event.preventDefault();
    event.stopPropagation();
    const dragging = mapEditorReducer(state, { type: 'dragStart', index });
    const moved = mapEditorReducer(dragging, { type: 'movePoint', point });
    const next = mapEditorReducer(moved, { type: 'dragEnd' });
    setState(next);
    if (next.draft && !next.warningKo) onSave(next.draft);
  };
  const handleMapKeyboard = (event: KeyboardEvent<SVGSVGElement>) => {
    if (state.mode !== 'drawing') return;
    const nextCursor = moveKeyboardCursor(keyboardCursor, event.key, event.shiftKey);
    if (nextCursor) {
      event.preventDefault();
      setKeyboardCursor(nextCursor);
      setLiveMessage(
        `키보드 커서 가로 ${Math.round(nextCursor[0] * 100)}%, 세로 ${Math.round(nextCursor[1] * 100)}%`,
      );
      return;
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      send({ type: 'addPoint', point: keyboardCursor });
      setLiveMessage(`${state.points.length + 1}번째 꼭짓점을 추가했습니다.`);
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      send({ type: 'cancel' });
      setLiveMessage('영역 그리기를 취소했습니다.');
    }
  };
  return (
    <section id="region-editor" className="map-panel">
      <div className="map-panel__heading">
        <div>
          <span>REGION EDITOR</span>
          <h2>미니맵에서 영역 만들기</h2>
        </div>
        {state.mode === 'idle' || state.mode === 'selected' ? (
          <button onClick={startDrawing}>영역 그리기</button>
        ) : (
          <button onClick={() => send({ type: 'cancel' })}>취소</button>
        )}
      </div>
      {regions.length > 0 && (
        <div className="region-library" aria-label="저장한 영역">
          {regions.map((region) => (
            <div
              className={`region-library__item ${
                state.selectedId === region.id ? 'region-library__item--selected' : ''
              }`}
              key={region.id}
            >
              <button
                className="region-select"
                aria-pressed={state.selectedId === region.id}
                onClick={() => selectRegion(region)}
              >
                {region.label}
              </button>
              <button
                className="danger-icon region-delete"
                aria-label={`${region.label} 영역 삭제`}
                title="영역 삭제"
                onClick={() => {
                  if (!window.confirm(`“${region.label}” 영역을 삭제할까요?`)) return;
                  send({ type: 'cancel' });
                  onDelete(region);
                }}
              >
                삭제
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="minimap-stack">
        <img
          className="minimap-image"
          src={SUMMONERS_RIFT_MAP_URL}
          alt=""
          aria-hidden="true"
          draggable={false}
        />
        <HeatmapCanvas points={displayableHeatmapPoints} />
        <svg
          ref={mapSvg}
          className={`minimap minimap--${state.mode}`}
          viewBox="0 0 1000 1000"
          preserveAspectRatio="xMidYMid meet"
          role="group"
          tabIndex={state.mode === 'drawing' ? 0 : -1}
          aria-label="소환사의 협곡 영역 편집 미니맵"
          aria-describedby={state.mode === 'drawing' ? 'map-drawing-instructions' : undefined}
          onClick={addPoint}
          onKeyDown={handleMapKeyboard}
        >
          <title>소환사의 협곡 영역 편집기</title>
          <desc>실제 소환사의 협곡 미니맵 위에서 분석 영역을 선택하고 편집합니다.</desc>
          {regions.map((region) => (
            <g
              key={region.id}
              role="button"
              tabIndex={state.mode === 'drawing' ? -1 : 0}
              aria-label={`${region.label} 영역 선택`}
              aria-pressed={state.selectedId === region.id}
              onClick={(event) => {
                if (state.mode === 'drawing') return;
                event.stopPropagation();
                selectRegion(region);
              }}
              onKeyDown={(event) => selectRegionWithKeyboard(event, region)}
            >
              <Shape
                shape={region.shape}
                className={region.id === activeRegionId ? 'region region--active' : 'region'}
              />
            </g>
          ))}
          {state.points.length > 0 && (
            <>
              <polyline className="region-draft" points={state.points.map(screenPoint).join(' ')} />
              {state.points.map((point, index) => (
                <circle
                  className="region-handle"
                  key={index}
                  role="button"
                  tabIndex={state.mode === 'editing' ? 0 : -1}
                  aria-label={`${index + 1}번 꼭짓점. 화살표 키로 이동`}
                  cx={point[0] * 1000}
                  cy={(1 - point[1]) * 1000}
                  r="10"
                  onKeyDown={(event) => moveVertexWithKeyboard(event, index)}
                  onPointerDown={(event) => {
                    if (state.mode !== 'editing') return;
                    event.stopPropagation();
                    event.currentTarget.setPointerCapture(event.pointerId);
                    send({ type: 'dragStart', index });
                  }}
                  onPointerMove={(event) => {
                    if (state.mode !== 'dragging' || state.draggingIndex !== index) return;
                    send({ type: 'movePoint', point: pointerPoint(event) });
                  }}
                  onPointerUp={(event) => {
                    if (state.mode !== 'dragging') return;
                    event.stopPropagation();
                    finishDrag();
                  }}
                />
              ))}
            </>
          )}
          {state.mode === 'drawing' && (
            <g className="keyboard-cursor" aria-hidden="true">
              <circle cx={keyboardCursor[0] * 1000} cy={(1 - keyboardCursor[1]) * 1000} r="15" />
              <path
                d={`M ${keyboardCursor[0] * 1000 - 25} ${(1 - keyboardCursor[1]) * 1000} h 50 M ${keyboardCursor[0] * 1000} ${(1 - keyboardCursor[1]) * 1000 - 25} v 50`}
              />
            </g>
          )}
        </svg>
      </div>
      {displayableHeatmapPoints.length > 0 && (
        <small className="heatmap-count">
          {heatmapSampleLabelKo(displayableHeatmapPoints.length, heatmapTotal)}
        </small>
      )}
      {state.mode === 'drawing' && (
        <>
          <p id="map-drawing-instructions" className="map-instructions">
            마우스로 꼭짓점을 찍거나, 미니맵에서 화살표 키로 십자 커서를 이동하고 Enter 또는 Space를
            누르세요. Shift+화살표는 더 크게 이동하며 Escape는 취소합니다.
          </p>
          <div className="map-controls">
            <span>추가한 꼭짓점 {state.points.length}개</span>
            <div className="map-control-actions">
              <button onClick={startDrawing} disabled={state.points.length === 0}>
                처음부터 다시
              </button>
              <button
                disabled={state.points.length < 3}
                onClick={() => send({ type: 'finishDrawing' })}
              >
                도형 완성
              </button>
            </div>
          </div>
        </>
      )}
      {state.mode === 'naming' && (
        <div className="map-naming">
          <label>
            영역 이름
            <input value={label} onChange={(event) => setLabel(event.target.value)} />
          </label>
          <label>
            영문 id
            <input value={id} onChange={(event) => setId(event.target.value)} />
          </label>
          <button onClick={save}>저장하고 조건에 적용</button>
        </div>
      )}
      {state.mode === 'selected' && state.draft?.shape.kind === 'polygon' && (
        <div className="map-controls">
          <span>{state.draft.label}</span>
          <button onClick={() => send({ type: 'edit' })}>꼭짓점 편집</button>
        </div>
      )}
      {(state.mode === 'editing' || state.mode === 'dragging') && state.draft && (
        <div className="map-controls">
          <span>꼭짓점을 드래그하거나 화살표 키로 이동해 영역을 조정하세요.</span>
          <button
            disabled={Boolean(state.warningKo)}
            onClick={() => send({ type: 'select', region: state.draft! })}
          >
            편집 완료
          </button>
        </div>
      )}
      {state.warningKo && <p className="map-warning">{state.warningKo}</p>}
      <p className="map-live-status" aria-live="polite" aria-atomic="true">
        {liveMessage}
      </p>
      <small>
        영역은 서로 겹칠 수 있습니다. 라인·정글 합계가 전체와 일치하지 않을 수 있습니다.
      </small>
    </section>
  );
}
