/**
 * F1 Pitwall — Grid Canvas
 *
 * The main content area hosting react-grid-layout with all active panels.
 */

import React, { useRef, useState, useEffect } from 'react';
import GridLayout from 'react-grid-layout';
import 'react-grid-layout/css/styles.css';
import 'react-resizable/css/styles.css';
import { useLayoutStore } from '../store/layoutStore';
import { PanelCard } from './PanelCard';

export const GridCanvas: React.FC = () => {
  const { currentLayout, activePanels, setLayout } = useLayoutStore();
  const containerRef = useRef<HTMLDivElement>(null);
  const [canvasWidth, setCanvasWidth] = useState(1200);

  // Track container width
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setCanvasWidth(entry.contentRect.width);
      }
    });

    observer.observe(el);
    setCanvasWidth(el.clientWidth);

    return () => observer.disconnect();
  }, []);

  const GridLayoutComponent = GridLayout as any;

  return (
    <div className="grid-canvas" ref={containerRef}>
      <GridLayoutComponent
        className="react-grid-layout"
        layout={currentLayout as any}
        rowHeight={60}
        width={canvasWidth}
        onLayoutChange={setLayout}
        draggableHandle=".panel-header"
        resizeHandles={['se']}
        compactType="vertical"
        margin={[12, 12]}
      >
        {activePanels.map(panel => (
          <div key={panel.instanceId}>
            <PanelCard
              instanceId={panel.instanceId}
              panelTypeId={panel.panelTypeId}
              config={panel.config}
            />
          </div>
        ))}
      </GridLayoutComponent>
    </div>
  );
};
