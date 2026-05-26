/**
 * F1 Pitwall — Panel Registry
 *
 * Maps panel type IDs to their React components.
 * New panels register here — nothing else changes.
 */

import type React from 'react';

export interface PanelDefinition {
  id: string;
  title: string;
  category: string;
  Component: React.FC<PanelProps>;
}

export interface PanelProps {
  sessionKey: string | null;
  config: Record<string, unknown>;
  width: number;
  height: number;
}

const registry = new Map<string, PanelDefinition>();

export function registerPanel(definition: PanelDefinition): void {
  registry.set(definition.id, definition);
}

export function getPanel(id: string): PanelDefinition | undefined {
  return registry.get(id);
}

export function getAllPanels(): PanelDefinition[] {
  return Array.from(registry.values());
}
