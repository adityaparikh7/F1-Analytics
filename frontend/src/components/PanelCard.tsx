/**
 * F1 Pitwall — Panel Card Component
 *
 * Wraps every panel with consistent header, drag handle, and actions.
 */

import React, { useRef, useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { getPanel } from '../core/panelRegistry';
import { useLayoutStore } from '../store/layoutStore';
import { useSessionStore } from '../store/sessionStore';

interface PanelCardProps {
  instanceId: string;
  panelTypeId: string;
  config: Record<string, unknown>;
}

export const PanelCard: React.FC<PanelCardProps> = ({ instanceId, panelTypeId, config }) => {
  const removePanel = useLayoutStore(s => s.removePanel);
  const activeSessionKey = useSessionStore(s => s.activeSessionKey);
  const contentRef = useRef<HTMLDivElement>(null);
  const [dimensions, setDimensions] = useState({ width: 0, height: 0 });

  const definition = getPanel(panelTypeId);

  // Track panel content dimensions via ResizeObserver
  useEffect(() => {
    const el = contentRef.current;
    if (!el) return;

    let timeoutId: ReturnType<typeof setTimeout>;
    const observer = new ResizeObserver((entries) => {
      clearTimeout(timeoutId);
      timeoutId = setTimeout(() => {
        for (const entry of entries) {
          setDimensions({
            width: entry.contentRect.width,
            height: entry.contentRect.height,
          });
        }
      }, 150); // Debounce during active resize
    });

    observer.observe(el);
    return () => {
      clearTimeout(timeoutId);
      observer.disconnect();
    };
  }, []);

  if (!definition) {
    return (
      <div className="panel-card">
        <div className="panel-card__header panel-header">
          <span className="panel-card__title">Unknown Panel</span>
        </div>
        <div className="panel-card__content">
          <div className="state-error">
            Panel type "{panelTypeId}" not registered
          </div>
        </div>
      </div>
    );
  }

  const { Component } = definition;

  return (
    <div className="panel-card">
      <div className="panel-card__header panel-header">
        <span className="panel-card__title">{definition.title}</span>
        <button
          className="panel-card__action"
          onClick={() => removePanel(instanceId)}
          title="Remove panel"
          style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}
        >
          <X size={14} />
        </button>
      </div>
      <div className="panel-card__content" ref={contentRef}>
        <Component
          sessionKey={activeSessionKey}
          config={config}
          width={dimensions.width}
          height={dimensions.height}
        />
      </div>
    </div>
  );
};
