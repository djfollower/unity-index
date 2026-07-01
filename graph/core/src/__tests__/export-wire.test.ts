import { describe, expect, it } from 'vitest';
import {
  EXPORT_SCHEMA_MAJOR,
  EXPORT_SCHEMA_VERSION,
  ExportValidationError,
  assertCompatibleExport,
  createExportEnvelope,
  parseSchemaVersion,
  type ExportDocument,
} from '../export-wire.js';
import type { GraphSnapshot } from '../graph-types.js';

const emptySnapshot: GraphSnapshot = {
  nodes: [],
  edges: [],
  generated_at: '2026-07-01T00:00:00Z',
  source_phase: 'asset',
  stats: {
    node_count: 0,
    edge_count: 0,
    skipped_component_instances: 0,
    skipped_component_fields: 0,
  },
};

describe('parseSchemaVersion', () => {
  it('parses <major>.<minor>', () => {
    expect(parseSchemaVersion('1.0')).toEqual({ major: 1, minor: 0 });
    expect(parseSchemaVersion('2.7')).toEqual({ major: 2, minor: 7 });
  });

  it('rejects malformed input', () => {
    expect(() => parseSchemaVersion('1')).toThrow(ExportValidationError);
    expect(() => parseSchemaVersion('1.0.0')).toThrow(ExportValidationError);
    expect(() => parseSchemaVersion('v1.0')).toThrow(ExportValidationError);
    expect(() => parseSchemaVersion('')).toThrow(ExportValidationError);
  });
});

describe('createExportEnvelope', () => {
  it('emits current schema version and ISO exportedAt', () => {
    const doc = createExportEnvelope({
      snapshot: emptySnapshot,
      producer: 'vscode',
      producerVersion: '0.5.8',
      now: () => new Date('2026-07-01T12:00:00Z'),
    });
    expect(doc.schemaVersion).toBe(EXPORT_SCHEMA_VERSION);
    expect(doc.exportedAt).toBe('2026-07-01T12:00:00.000Z');
    expect(doc.meta.producer).toBe('vscode');
    expect(doc.snapshot).toBe(emptySnapshot);
  });
});

describe('assertCompatibleExport', () => {
  const good: ExportDocument = {
    schemaVersion: EXPORT_SCHEMA_VERSION,
    exportedAt: '2026-07-01T00:00:00.000Z',
    meta: { producer: 'mcp', producerVersion: '0.5.8' },
    snapshot: emptySnapshot,
  };

  it('accepts a well-formed document', () => {
    expect(assertCompatibleExport(good)).toBe(good);
  });

  it('rejects non-objects', () => {
    expect(() => assertCompatibleExport(null)).toThrow(/must be a JSON object/);
    expect(() => assertCompatibleExport([])).toThrow(/must be a JSON object/);
    expect(() => assertCompatibleExport('nope')).toThrow(/must be a JSON object/);
  });

  it('rejects missing schemaVersion', () => {
    const { schemaVersion: _drop, ...rest } = good;
    expect(() => assertCompatibleExport(rest)).toThrow(/missing "schemaVersion"/);
  });

  it('rejects incompatible major version', () => {
    const doc = { ...good, schemaVersion: `${EXPORT_SCHEMA_MAJOR + 1}.0` };
    expect(() => assertCompatibleExport(doc)).toThrow(/not supported by this build/);
  });

  it('accepts a future minor bump on the same major', () => {
    const doc = { ...good, schemaVersion: `${EXPORT_SCHEMA_MAJOR}.99` };
    expect(assertCompatibleExport(doc)).toEqual(doc);
  });

  it('rejects missing snapshot', () => {
    const { snapshot: _drop, ...rest } = good;
    expect(() => assertCompatibleExport(rest)).toThrow(/missing "snapshot"/);
  });
});
