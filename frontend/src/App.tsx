/**
 * F1 Pitwall — App Root
 *
 * Assembles the shell: topbar, sidebar, grid canvas, catalogue drawer.
 */

import React from 'react';
import { Topbar } from './components/Topbar';
import { Sidebar } from './components/Sidebar';
import { GridCanvas } from './components/GridCanvas';
import { CatalogueDrawer } from './components/CatalogueDrawer';

// ── Register all panels ─────────────────────────────────────────────
// Each import triggers the registerPanel() call in the module
import './panels/session-results/SessionResultsPanel';
import './panels/strategy-board/StrategyBoardPanel';
import './panels/lap-distribution/LapDistributionPanel';
import './panels/season-calendar/SeasonCalendarPanel';
import './panels/driver-standings/DriverStandingsPanel';
import './panels/constructor-standings/ConstructorStandingsPanel';
import './panels/lap-progression/LapProgressionPanel';
import './panels/position-changes/PositionChangesPanel';
import './panels/telemetry-explorer/TelemetryExplorerPanel';
import './panels/track-map/TrackMapPanel';
import './panels/qualifying-comparison/QualifyingComparisonPanel';
import './panels/top-speed-plot/TopSpeedPlotPanel';
import './panels/speed-trace/SpeedTracePanel';
import './panels/aero-map/AeroMapPanel';

const App: React.FC = () => {
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
