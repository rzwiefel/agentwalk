import { architectureControlsVisible } from './components/ControlPanel';
import { shouldRenderInactiveAgents } from './components/GraphCanvas';

function expect(condition: boolean, message: string): void {
  if (!condition) throw new Error(`Activity mode UX assertion failed: ${message}`);
}

function runActivityModeUxAssertions(): void {
  expect(!architectureControlsVisible('activity'),
    'namespace search, repository analysis, detected capabilities, and node scale are hidden in Live Activity');
  expect(architectureControlsVisible('architecture'),
    'architecture controls remain available in Architecture mode');
  expect(shouldRenderInactiveAgents(true, true),
    'inactive agent glyphs render by default in Live Activity');
  expect(!shouldRenderInactiveAgents(true, false),
    'inactive agent glyphs are hidden when their toggle is off');
  expect(!shouldRenderInactiveAgents(false, true),
    'inactive agent glyphs are not rendered outside Live Activity');
}

type NodeTest = (name: string, assertion: () => void) => void;
const { test: nodeTest } = await import('node:' + 'test') as unknown as { test: NodeTest };
nodeTest('activity mode UX', runActivityModeUxAssertions);
