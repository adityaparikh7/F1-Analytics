/**
 * Race Replay — shared inline styles.
 *
 * Same tokens and shapes as the other analysis pages (see ChampionshipPage's card/select
 * styles), gathered here because the replay is split across several components.
 */

import type React from 'react';

export const cardStyle: React.CSSProperties = {
  backgroundColor: 'var(--bg-panel)',
  borderRadius: 'var(--radius-lg)',
  border: '1px solid var(--border-default)',
  padding: 'var(--space-3)',
  minWidth: 0,
};

export const cardTitleStyle: React.CSSProperties = {
  fontSize: 'var(--fs-xs)',
  fontWeight: 600,
  letterSpacing: '0.06em',
  textTransform: 'uppercase',
  color: 'var(--text-secondary)',
  marginBottom: 'var(--space-2)',
};

export const selectStyle: React.CSSProperties = {
  padding: 'var(--space-1) var(--space-2)',
  borderRadius: 'var(--radius-md)',
  backgroundColor: 'var(--bg-raised)',
  border: '1px solid var(--border-default)',
  color: 'var(--text-primary)',
  fontSize: 'var(--fs-sm)',
  cursor: 'pointer',
  outline: 'none',
};

export const buttonStyle: React.CSSProperties = {
  ...selectStyle,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 'var(--space-1)',
};

export const iconButtonStyle: React.CSSProperties = {
  ...buttonStyle,
  width: 32,
  height: 28,
  padding: 0,
};

export function toggleStyle(active: boolean): React.CSSProperties {
  return {
    ...buttonStyle,
    backgroundColor: active ? 'var(--bg-active)' : 'var(--bg-raised)',
    borderColor: active ? 'var(--border-strong)' : 'var(--border-default)',
    color: active ? 'var(--text-primary)' : 'var(--text-secondary)',
  };
}
