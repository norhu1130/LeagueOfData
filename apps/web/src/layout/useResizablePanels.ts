import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import {
  DESKTOP_RESULT_BREAKPOINT,
  MOBILE_BREAKPOINT,
  PANEL_LAYOUT_PREFERENCE,
  PANEL_WIDTH_LIMITS,
  clamp,
  fitPanelWidths,
  maximumPanelWidth,
  preferredPanelWidths,
  type AppShellStyle,
  type PanelName,
} from './panel-layout.js';

export function useResizablePanels(resultPaneVisible: boolean) {
  const [panelWidths, setPanelWidths] = useState(preferredPanelWidths);
  const appShell = useRef<HTMLDivElement>(null);
  const panelResizeAbort = useRef<AbortController | null>(null);
  const appShellStyle: AppShellStyle = {
    '--sidebar-width': `${panelWidths.sidebar}px`,
    '--result-width': `${panelWidths.result}px`,
  };

  const resizePanelTo = useCallback(
    (panel: PanelName, requestedWidth: number) => {
      const shellWidth = appShell.current?.getBoundingClientRect().width ?? window.innerWidth;
      setPanelWidths((current) => {
        const maximum = maximumPanelWidth(panel, current, shellWidth, resultPaneVisible);
        return {
          ...current,
          [panel]: clamp(
            requestedWidth,
            PANEL_WIDTH_LIMITS[panel].min,
            Math.max(PANEL_WIDTH_LIMITS[panel].min, maximum),
          ),
        };
      });
    },
    [resultPaneVisible],
  );

  const beginPanelResize = useCallback(
    (panel: PanelName, event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.button !== 0 || window.innerWidth <= MOBILE_BREAKPOINT) return;
      if (panel === 'result' && window.innerWidth <= DESKTOP_RESULT_BREAKPOINT) return;
      event.preventDefault();
      panelResizeAbort.current?.abort();
      const controller = new AbortController();
      panelResizeAbort.current = controller;
      const startX = event.clientX;
      const startWidth = panelWidths[panel];
      const handle = event.currentTarget;
      const pointerId = event.pointerId;
      // Keep receiving movement if the pointer outruns the narrow 8 px separator or the page
      // rerenders while a result finishes loading.
      handle.setPointerCapture(pointerId);
      document.body.classList.add('panel-resizing');
      const move = (moveEvent: PointerEvent) => {
        const delta = moveEvent.clientX - startX;
        resizePanelTo(panel, startWidth + (panel === 'sidebar' ? delta : -delta));
      };
      const stop = () => {
        controller.abort();
        if (handle.hasPointerCapture(pointerId)) handle.releasePointerCapture(pointerId);
        if (panelResizeAbort.current === controller) panelResizeAbort.current = null;
        document.body.classList.remove('panel-resizing');
      };
      window.addEventListener('pointermove', move, { signal: controller.signal });
      window.addEventListener('pointerup', stop, { signal: controller.signal });
      window.addEventListener('pointercancel', stop, { signal: controller.signal });
    },
    [panelWidths, resizePanelTo],
  );

  const resizePanelWithKeyboard = useCallback(
    (panel: PanelName, event: ReactKeyboardEvent<HTMLDivElement>) => {
      const direction = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
      if (!direction) return;
      event.preventDefault();
      const signedDirection = panel === 'sidebar' ? direction : -direction;
      resizePanelTo(panel, panelWidths[panel] + signedDirection * 16);
    },
    [panelWidths, resizePanelTo],
  );

  useEffect(() => {
    window.localStorage.setItem(PANEL_LAYOUT_PREFERENCE, JSON.stringify(panelWidths));
  }, [panelWidths]);

  useEffect(() => {
    const fit = () => {
      const shellWidth = appShell.current?.getBoundingClientRect().width ?? window.innerWidth;
      setPanelWidths((current) => fitPanelWidths(current, shellWidth, resultPaneVisible));
    };
    fit();
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  }, [resultPaneVisible]);

  useEffect(
    () => () => {
      panelResizeAbort.current?.abort();
      document.body.classList.remove('panel-resizing');
    },
    [],
  );

  return {
    appShell,
    appShellStyle,
    panelWidths,
    beginPanelResize,
    resizePanelTo,
    resizePanelWithKeyboard,
  };
}
