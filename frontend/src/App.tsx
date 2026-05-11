/**
 * F1 Pitwall — App Root
 *
 * Assembles the shell: topbar, sidebar, grid canvas, catalogue drawer.
 */

import React, { useEffect } from 'react';
import { Topbar } from './components/Topbar';
import { Sidebar } from './components/Sidebar';
import { GridCanvas } from './components/GridCanvas';
import { CatalogueDrawer } from './components/CatalogueDrawer';
import { useLayoutStore } from './store/layoutStore';

// ── Register all panels ─────────────────────────────────────────────
// Each import triggers the registerPanel() call in the module
import './panels/session-results/SessionResultsPanel';
import './panels/strategy-board/StrategyBoardPanel';
import './panels/lap-distribution/LapDistributionPanel';

const App: React.FC = () => {
  const restoreFromStorage = useLayoutStore(s => s.restoreFromStorage);

  // Restore layout on mount
  useEffect(() => {
    restoreFromStorage();
  }, []);

  return (
    <>
      <Topbar />
      <div className="app-layout">
        <Sidebar />
        <GridCanvas />
      </div>
      <CatalogueDrawer />
    </>
  );
};

export default App;
