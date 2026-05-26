/**
 * F1 Pitwall — Panel Catalogue Drawer
 *
 * Slide-out drawer listing all available panels, grouped by category.
 * Keyboard shortcut: Cmd/Ctrl + K
 */

import React, { useState, useEffect } from 'react';
import { useUIStore } from '../store/uiStore';
import { useLayoutStore } from '../store/layoutStore';
import type { PanelCatalogueItem } from '../lib/api';
import { api } from '../lib/api';

export const CatalogueDrawer: React.FC = () => {
  const { catalogueOpen, closeCatalogue } = useUIStore();
  const addPanel = useLayoutStore(s => s.addPanel);
  const [panels, setPanels] = useState<PanelCatalogueItem[]>([]);
  const [search, setSearch] = useState('');

  // Load panel catalogue
  useEffect(() => {
    api.getPanels().then(setPanels).catch(console.error);
  }, []);

  // Keyboard shortcut: Cmd/Ctrl + K
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        useUIStore.getState().toggleCatalogue();
      }
      if (e.key === 'Escape' && catalogueOpen) {
        closeCatalogue();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [catalogueOpen, closeCatalogue]);

  if (!catalogueOpen) return null;

  const filtered = panels.filter(p =>
    p.title.toLowerCase().includes(search.toLowerCase()) ||
    p.description.toLowerCase().includes(search.toLowerCase())
  );

  // Group by category
  const grouped: Record<string, PanelCatalogueItem[]> = {};
  for (const panel of filtered) {
    if (!grouped[panel.category]) grouped[panel.category] = [];
    grouped[panel.category].push(panel);
  }

  const categoryLabels: Record<string, string> = {
    session: 'Session',
    telemetry: 'Telemetry',
    strategy: 'Strategy',
    performance: 'Performance',
    aero: 'Aero & Energy',
  };

  const handleAdd = (panel: PanelCatalogueItem) => {
    addPanel(panel.id, panel.defaultSize);
    closeCatalogue();
  };

  return (
    <>
      <div className="catalogue-overlay" onClick={closeCatalogue} />
      <div className="catalogue-drawer">
        <div className="catalogue-drawer__header">
          <div className="catalogue-drawer__title">Add Panel</div>
          <input
            className="catalogue-drawer__search"
            type="text"
            placeholder="Search panels... (⌘K)"
            value={search}
            onChange={e => setSearch(e.target.value)}
            autoFocus
          />
        </div>
        <div className="catalogue-drawer__body">
          {Object.entries(grouped).map(([category, items]) => (
            <div className="catalogue-category" key={category}>
              <div className="catalogue-category__title">
                {categoryLabels[category] || category}
              </div>
              {items.map(panel => (
                <div
                  className="catalogue-panel-item"
                  key={panel.id}
                  onClick={() => handleAdd(panel)}
                >
                  <div className="catalogue-panel-item__title">{panel.title}</div>
                  <div className="catalogue-panel-item__description">
                    {panel.description}
                  </div>
                </div>
              ))}
            </div>
          ))}
          {filtered.length === 0 && (
            <div className="state-empty">No panels match your search</div>
          )}
        </div>
      </div>
    </>
  );
};
