// Day 9.1 — domain classifier coverage. The reducer composes these into
// node/edge visibility, so a bad classification immediately becomes a
// rendering bug.

import { describe, it, expect } from 'vitest';
import {
  edgeHiddenByDomain,
  isCodeEdgeKind,
  isCodeNodeKind,
  isFilterDomain,
  nodeHiddenByDomain,
} from '../domain';

describe('domain classification', () => {
  it('classifies node kinds', () => {
    expect(isCodeNodeKind('class')).toBe(true);
    expect(isCodeNodeKind('method')).toBe(true);
    expect(isCodeNodeKind('namespace')).toBe(true);
    // Scripts are asset-domain — they're .cs files with a GUID, the class
    // declared inside is the code-side anchor.
    expect(isCodeNodeKind('script')).toBe(false);
    expect(isCodeNodeKind('prefab')).toBe(false);
    expect(isCodeNodeKind('scene')).toBe(false);
    expect(isCodeNodeKind('so')).toBe(false);
    expect(isCodeNodeKind('unknown_kind')).toBe(false);
  });

  it('classifies edge kinds', () => {
    expect(isCodeEdgeKind('class_inherits_from')).toBe(true);
    expect(isCodeEdgeKind('method_calls_method')).toBe(true);
    expect(isCodeEdgeKind('script_used_by_prefab')).toBe(false);
    // The bridging edge is in neither set; the reducer hides it via the
    // endpoint check instead.
    expect(isCodeEdgeKind('script_declares_class')).toBe(false);
  });
});

describe('nodeHiddenByDomain', () => {
  it('combined shows everything', () => {
    expect(nodeHiddenByDomain('combined', 'class')).toBe(false);
    expect(nodeHiddenByDomain('combined', 'prefab')).toBe(false);
  });

  it('assets hides code-kind nodes', () => {
    expect(nodeHiddenByDomain('assets', 'class')).toBe(true);
    expect(nodeHiddenByDomain('assets', 'method')).toBe(true);
    expect(nodeHiddenByDomain('assets', 'prefab')).toBe(false);
    expect(nodeHiddenByDomain('assets', 'script')).toBe(false);
  });

  it('code hides asset-kind nodes', () => {
    expect(nodeHiddenByDomain('code', 'prefab')).toBe(true);
    expect(nodeHiddenByDomain('code', 'scene')).toBe(true);
    expect(nodeHiddenByDomain('code', 'script')).toBe(true);
    expect(nodeHiddenByDomain('code', 'class')).toBe(false);
    expect(nodeHiddenByDomain('code', 'method')).toBe(false);
  });

  it('treats unknown kinds as asset domain (conservative)', () => {
    // A future kind shipped by a newer host should appear in assets mode
    // and disappear in code mode — better to over-show than over-hide.
    expect(nodeHiddenByDomain('assets', 'future_kind')).toBe(false);
    expect(nodeHiddenByDomain('code', 'future_kind')).toBe(true);
  });
});

describe('edgeHiddenByDomain', () => {
  it('combined shows every edge kind', () => {
    expect(edgeHiddenByDomain('combined', 'class_inherits_from')).toBe(false);
    expect(edgeHiddenByDomain('combined', 'script_used_by_prefab')).toBe(false);
  });

  it('assets hides code edges', () => {
    expect(edgeHiddenByDomain('assets', 'class_inherits_from')).toBe(true);
    expect(edgeHiddenByDomain('assets', 'method_calls_method')).toBe(true);
    expect(edgeHiddenByDomain('assets', 'script_used_by_prefab')).toBe(false);
  });

  it('code hides asset edges', () => {
    expect(edgeHiddenByDomain('code', 'script_used_by_prefab')).toBe(true);
    expect(edgeHiddenByDomain('code', 'scene_contains_prefab')).toBe(true);
    expect(edgeHiddenByDomain('code', 'class_inherits_from')).toBe(false);
  });

  it('hides the bridging edge in any single-domain mode', () => {
    // script_declares_class is not a code edge, so in 'code' mode it's
    // hidden directly. In 'assets' mode the kind alone doesn't hide it,
    // but the reducer hides it via the endpoint check (target is a class).
    // Either way it disappears in both single-domain modes.
    expect(edgeHiddenByDomain('assets', 'script_declares_class')).toBe(false);
    expect(edgeHiddenByDomain('code', 'script_declares_class')).toBe(true);
  });
});

describe('isFilterDomain', () => {
  it('accepts known values', () => {
    expect(isFilterDomain('assets')).toBe(true);
    expect(isFilterDomain('code')).toBe(true);
    expect(isFilterDomain('combined')).toBe(true);
  });

  it('rejects unknown values', () => {
    expect(isFilterDomain('everything')).toBe(false);
    expect(isFilterDomain(null)).toBe(false);
    expect(isFilterDomain(undefined)).toBe(false);
    expect(isFilterDomain(7)).toBe(false);
  });
});
