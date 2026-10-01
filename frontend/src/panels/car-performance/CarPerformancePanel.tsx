import { useEffect, useState, type FC } from 'react';
import { useNavigate } from 'react-router-dom';
import { registerPanel } from '../../core/panelRegistry';
import type { PanelProps } from '../../core/panelRegistry';
import { api } from '../../lib/api';
import type { CarPerformanceResponse } from '../../lib/api';
import { getDriverColour, getTeamColour } from '../../lib/colours';
import { logger } from '../../lib/logger';

export const CarPerformancePanel: FC<PanelProps> = ({ sessionKey, width, height }) => {
  const navigate = useNavigate();
  const [data, setData] = useState<CarPerformanceResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;

    async function loadData() {
      if (!sessionKey) return;
      setLoading(true);
      setError(null);

      try {
        const response = await api.getCarPerformance(sessionKey);
        if (mounted) setData(response);
      } catch (err) {
        logger.error('Failed to load car performance data:', err);
        if (mounted) setError(err instanceof Error ? err.message : 'Failed to load data');
      } finally {
        if (mounted) setLoading(false);
      }
    }

    loadData();
    return () => { mounted = false; };
  }, [sessionKey]);

  if (!sessionKey) {
    return (
      <div className="state-empty" style={{ width, height, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ color: 'var(--text-tertiary)', fontSize: 'var(--fs-sm)' }}>Select a session to view car performance</div>
      </div>
    );
  }

  if (loading && !data) {
    return <div className="state-loading" style={{ width, height }}>Loading performance data…</div>;
  }

  if (error) {
    return (
      <div className="state-error" style={{ width, height, display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 'var(--space-2)', color: 'var(--accent-red)' }}>
        <div style={{ fontSize: 'var(--fs-sm)' }}>{error}</div>
      </div>
    );
  }

  if (!data || data.drivers.length === 0) {
    return (
      <div className="state-empty" style={{ width, height, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ color: 'var(--text-tertiary)', fontSize: 'var(--fs-sm)' }}>No performance data available</div>
      </div>
    );
  }

  const { drivers } = data;

  // Highlights
  const bestTopSpeedDriver = [...drivers].sort((a, b) => b.aero.top_speed - a.aero.top_speed)[0];
  const mostAggressiveDriver = [...drivers].sort((a, b) => b.driving_style.full_throttle - a.driving_style.full_throttle)[0];

  const driversWithAvgCorner = drivers.map(d => {
    const valid = d.corner_speeds.filter(c => c.apex_speed !== null);
    const avg = valid.length > 0
      ? valid.reduce((sum, c) => sum + (c.apex_speed || 0), 0) / valid.length
      : 0;
    return { ...d, avgCornerSpeed: avg };
  });
  const bestCorneringDriver = [...driversWithAvgCorner].sort((a, b) => b.avgCornerSpeed - a.avgCornerSpeed)[0];

  const sortedByThrottle = [...drivers].sort((a, b) => b.driving_style.full_throttle - a.driving_style.full_throttle);

  const highlights = [
    {
      label: 'Best Top Speed',
      driver: bestTopSpeedDriver.driver,
      team: bestTopSpeedDriver.team,
      value: bestTopSpeedDriver.aero.top_speed.toFixed(1),
      unit: 'km/h',
    },
    {
      label: 'Most Aggressive',
      driver: mostAggressiveDriver.driver,
      team: mostAggressiveDriver.team,
      value: mostAggressiveDriver.driving_style.full_throttle.toFixed(1),
      unit: '% throttle',
    },
    {
      label: 'Best Cornering',
      driver: bestCorneringDriver.driver,
      team: bestCorneringDriver.team,
      value: bestCorneringDriver.avgCornerSpeed.toFixed(1),
      unit: 'km/h avg',
    },
  ];

  return (
    <div style={{
      width, height,
      display: 'flex',
      flexDirection: 'column',
      padding: 'var(--space-3)',
      boxSizing: 'border-box',
      overflow: 'hidden',
    }}>
      {/* Toolbar — matches TelemetryExplorerPanel header pattern */}
      <div style={{
        display: 'flex',
        justifyContent: 'flex-end',
        alignItems: 'center',
        marginBottom: 'var(--space-3)',
      }}>
        <button
          className="btn btn--outline"
          onClick={() => navigate('/car-performance')}
          style={{
            fontSize: 'var(--fs-xs)',
            padding: '4px 10px',
            background: 'rgba(255,255,255,0.05)',
            border: '1px solid rgba(255,255,255,0.1)',
            color: 'var(--text-secondary)',
            cursor: 'pointer',
            borderRadius: 'var(--radius-sm)',
          }}
        >
          ⤢ Expand
        </button>
      </div>

      {/* Highlight cards */}
      <div style={{
        display: 'flex',
        gap: 'var(--space-2)',
        marginBottom: 'var(--space-3)',
      }}>
        {highlights.map(h => (
          <div key={h.label} style={{
            flex: 1,
            background: 'rgba(255, 255, 255, 0.03)',
            border: '1px solid rgba(255, 255, 255, 0.05)',
            borderRadius: 'var(--radius-lg)',
            padding: 'var(--space-2) var(--space-3)',
            display: 'flex',
            flexDirection: 'column',
            gap: '2px',
          }}>
            <div style={{
              fontSize: 'var(--fs-xs)',
              color: 'var(--text-tertiary)',
              textTransform: 'uppercase',
              letterSpacing: '0.05em',
            }}>
              {h.label}
            </div>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 'var(--space-2)' }}>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
                <span style={{
                  width: '8px',
                  height: '8px',
                  borderRadius: '50%',
                  backgroundColor: getTeamColour(h.team),
                  boxShadow: `0 0 6px ${getTeamColour(h.team)}`,
                  display: 'inline-block',
                  flexShrink: 0,
                }} />
                <span style={{
                  color: getDriverColour(h.driver, h.team),
                  fontWeight: 700,
                  fontSize: 'var(--fs-sm)',
                }}>
                  {h.driver}
                </span>
              </span>
              <span style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 'var(--fs-xs)',
                color: 'var(--text-primary)',
              }}>
                {h.value}
              </span>
              <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-tertiary)' }}>
                {h.unit}
              </span>
            </div>
          </div>
        ))}
      </div>

      {/* Driving style bars */}
      <div style={{
        flex: 1,
        background: 'rgba(255, 255, 255, 0.03)',
        border: '1px solid rgba(255, 255, 255, 0.05)',
        borderRadius: 'var(--radius-lg)',
        padding: 'var(--space-3)',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
      }}>
        <div style={{
          fontSize: 'var(--fs-sm)',
          fontWeight: 600,
          color: 'var(--text-secondary)',
          textTransform: 'uppercase',
          letterSpacing: '0.05em',
          marginBottom: 'var(--space-2)',
        }}>
          Driving Style
        </div>

        <div style={{
          flex: 1,
          overflowY: 'auto',
          display: 'flex',
          flexDirection: 'column',
          gap: '3px',
        }}>
          {sortedByThrottle.map(d => (
            <div key={d.driver} style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
              <div style={{ display: 'flex', alignItems: 'center', width: '44px', gap: '4px', flexShrink: 0 }}>
                <div style={{
                  width: '6px',
                  height: '6px',
                  borderRadius: '50%',
                  backgroundColor: getTeamColour(d.team),
                  flexShrink: 0,
                }} />
                <span style={{
                  fontSize: 'var(--fs-xs)',
                  fontFamily: 'var(--font-mono)',
                  fontWeight: 600,
                  color: 'var(--text-secondary)',
                }}>
                  {d.driver}
                </span>
              </div>

              <div style={{
                flex: 1,
                height: '10px',
                display: 'flex',
                borderRadius: '2px',
                overflow: 'hidden',
                backgroundColor: 'rgba(255, 255, 255, 0.05)',
              }}>
                <div
                  style={{ width: `${d.driving_style.full_throttle}%`, backgroundColor: 'var(--accent-teal)' }}
                  title={`Throttle: ${d.driving_style.full_throttle.toFixed(1)}%`}
                />
                <div
                  style={{ width: `${d.driving_style.coasting}%`, backgroundColor: 'var(--text-tertiary)' }}
                  title={`Coasting: ${d.driving_style.coasting.toFixed(1)}%`}
                />
                <div
                  style={{ width: `${d.driving_style.braking}%`, backgroundColor: 'var(--accent-red)' }}
                  title={`Braking: ${d.driving_style.braking.toFixed(1)}%`}
                />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};

registerPanel({
  id: 'car-performance',
  title: 'Car Performance',
  category: 'performance',
  Component: CarPerformancePanel,
});
