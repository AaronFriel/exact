// @ref LLP 1172.001 E4, §4 step 4 — today's Apple JSON wire, with one declaration.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const codecs = {
  string: ['String', '""', 'string()'],
  number: ['Double', '0', 'number()'],
  optionalNumber: ['Double?', 'nil', 'number()'],
  props: ['[String: String]', '[:]', 'strings()'],
  style: ['NodeStyle', '[:]', 'style()'],
  values: ['NodeStyle', '[:]', 'values()'],
  strings: ['[String]', '[]', 'array { try $0.string() }'],
  handlers: ['Set<String>', '[]', 'Set(try array { try $0.string() })'],
  ids: ['[UInt32]', '[]', 'array { try $0.id() }'],
  inline: ['[InlineText]', '[]', 'array { try $0.inline() }'],
  bool: ['Bool', 'false', 'bool()'],
  optionalBool: ['Bool?', 'nil', 'bool()'],
  optionalString: ['String?', 'nil', 'string()'],
  id: ['UInt32', '0', 'id()'],
  uint64String: ['UInt64', '0', null],
  ops: ['[BatchOp]', '[]', 'array { try $0.batchOp() }'],
  numbers: ['[Double]', '[]', 'array { try $0.number() }'],
  nativeTimers: ['[NativeTimerWake]?', 'nil', 'array { try $0.nativeTimer() }'],
  modes: ['[String: String]?', 'nil', 'batchModes()'],
  stringValue: ['String?', 'nil', 'value().string'],
  orientation: ['OrientationRequest?', 'nil', 'batchOrientation()'],
  sequence: ['(UInt64, UInt64)?', 'nil', 'batchSequence()'],
};
const identifier = name => name.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
const quoted = JSON.stringify;

function envelopeReader(record) {
  const fields = Object.entries(record.fields);
  const lines = ['extension BatchReader {', '    package mutating func batch() throws -> Batch {'];
  for (const [, field] of fields) {
    const [type, empty] = codecs[field.codec];
    lines.push(`        var ${field.member}: ${type} = ${empty}`);
  }
  lines.push('        var seen: Set<String> = []', '        try object { r, key in',
    '            guard seen.insert(key).inserted else { try r.skip(); return }',
    '            if try r.null() { return }', '            switch key {');
  for (const [key, field] of fields) lines.push(`            case ${quoted(key)}: ${field.member} = try r.${codecs[field.codec][2]}`);
  lines.push('            default: try r.skip()', '            }', '        }');
  const args = record.initializer.map(name => `${name}: ${name}`);
  lines.push(`        var batch = Batch(${args.join(', ')})`);
  for (const [, field] of fields.filter(([, f]) => !record.initializer.includes(f.member))) lines.push(`        batch.${field.member} = ${field.member}`);
  lines.push('        return batch', '    }', '}', '');
  return lines.join('\n');
}

function nativeTimerReader(record) {
  const fields = Object.entries(record.fields);
  const args = fields.map(([name]) => `${name}: ${name}`).join(', ');
  const lines = ['/// One ordinary task\'s native timer; generations reject delivery after cancellation.',
    'public struct NativeTimerWake: Equatable, Sendable {'];
  for (const [name, field] of fields) lines.push(`    public let ${name}: ${codecs[field.codec][0]}`);
  lines.push(`    public init(${fields.map(([n, f]) => `${n}: ${codecs[f.codec][0]}`).join(', ')}) {`);
  for (const [name] of fields) lines.push(`        self.${name} = ${name}`);
  lines.push('    }', '}', '', 'extension BatchReader {',
    '    package mutating func nativeTimer() throws -> NativeTimerWake {');
  for (const [name, field] of fields) lines.push(`        var ${name}: ${codecs[field.codec][0]}?`);
  lines.push('        try object { r, key in', '            switch key {');
  for (const [name, field] of fields) {
    const read = field.codec === 'uint64String' ? 'UInt64(try r.string())' : `try r.${codecs[field.codec][2]}`;
    lines.push(`            case ${quoted(name)}: ${name} = ${read}`);
  }
  lines.push('            default: try r.skip()', '            }', '        }');
  const guards = fields.flatMap(([name, field]) => [`let ${name}`,
    ...(field.minimum === undefined ? [] : [`${name} >= ${field.minimum}`]),
    ...(field.exclusiveMinimum === undefined ? [] : [`${name} > ${field.exclusiveMinimum}`])]);
  lines.push(`        guard ${guards.join(', ')} else { throw Invalid.wire }`,
    `        return NativeTimerWake(${args})`, '    }', '}', '');
  return lines.join('\n');
}

export function appleBatchReader(schema) {
  const records = schema.appleBatch.records;
  const members = new Map();
  for (const record of records) for (const field of Object.values(record.fields ?? {})) {
    if (!codecs[field.codec]) throw new Error(`unknown Apple batch codec: ${field.codec}`);
    const [type, empty] = codecs[field.codec];
    const declaration = `${type} = ${field.default === undefined ? empty : quoted(field.default)}`;
    if (members.has(field.member) && members.get(field.member) !== declaration) throw new Error(`conflicting Apple batch member: ${field.member}`);
    members.set(field.member, declaration);
  }
  const lines = [
    '// Generated from kernel/tables/schema.json by kernel/build/apple-batch.mjs. Do not edit.',
    '// @ref LLP 1172.001 E4, §4 step 4',
    'import Foundation', '', 'public struct BatchOp {',
    '    package enum Kind: String {',
    ...records.map(record => `        case ${identifier(record.name)} = ${quoted(record.name)}`),
    '        case unknown', '    }',
    '    package let op: Kind',
    '    package var nodeID: UInt32?',
    '    package var id: UInt32 { nodeID ?? 0 }',
    ...[...members].map(([name, declaration]) => `    package var ${name}: ${declaration}`),
    '    package var payload: [String: Any] = [:]',
    '    /// Prepared paint belongs to the owner, outside the wire.',
    '    package var flat: FlatPaint?',
    '    package init(op: Kind, nodeID: UInt32? = nil) { self.op = op; self.nodeID = nodeID }',
    '    package var isAdapter: Bool {', '        switch op {',
    `        case ${records.filter(r => r.fields).map(r => '.' + identifier(r.name)).join(', ')}: return false`,
    '        default: return true', '        }', '    }', '}', '',
    'extension BatchReader {',
    '    package mutating func recordField(_ op: inout BatchOp, key: String) throws {',
    '        switch (op.op, key) {',
    '        case (_, "id"): op.nodeID = try id()',
  ];
  for (const record of records) for (const [key, field] of Object.entries(record.fields ?? {})) {
    lines.push(`        case (.${identifier(record.name)}, ${quoted(key)}): op.${field.member} = ${field.codec === 'handlers' ? '' : 'try '}${codecs[field.codec][2]}`);
  }
  lines.push('        default: try skip()', '        }', '    }', '}', '',
    'extension BatchFields {',
    '    package func op(colorChannels: ((BatchValue, Bool) -> [Double]?)? = nil) throws -> BatchOp {',
    '        guard let name = try string("op") else { throw BatchReader.Invalid.wire }',
    '        var op = BatchOp(op: BatchOp.Kind(rawValue: name) ?? .unknown, nodeID: try id("id"))',
    '        switch op.op {');
  for (const record of records.filter(r => r.fields)) {
    lines.push(`        case .${identifier(record.name)}:`);
    if (!Object.keys(record.fields).length) lines.push('            break');
    for (const [key, field] of Object.entries(record.fields)) {
      const q = quoted(key);
      const reads = {
        string: `string(${q}) ?? ${quoted(field.default ?? '')}`,
        number: `number(${q}) ?? ${quoted(field.default ?? 0)}`, optionalNumber: `number(${q})`,
        props: `strings(${q})`, style: `CalculatedLength.decode(object(${q}))`, values: `object(${q})`,
        strings: `array(${q}, Self.string)`, handlers: `Set(try array(${q}, Self.string))`,
        ids: `array(${q}, Self.id)`, inline: `array(${q}) { try Self(Self.object($0)).inline(colorChannels: colorChannels) }`,
      };
      lines.push(`            op.${field.member} = ${field.codec === 'handlers' ? '' : 'try '}${reads[field.codec]}`);
    }
  }
  lines.push('        default: op.payload = fields.mapValues(\\.any)',
    '        }', '        return op', '    }', '}', '');
  return lines.join('\n') + '\n' + envelopeReader(schema.appleBatch.envelope) + '\n' + nativeTimerReader(schema.appleBatch.nativeTimer);
}

export function writeAppleBatchReader() {
  const schema = JSON.parse(readFileSync(new URL('../tables/schema.json', import.meta.url), 'utf8'));
  const output = fileURLToPath(new URL('../../host/apple/Sources/ExactCore/GeneratedBatch.swift', import.meta.url));
  const source = appleBatchReader(schema);
  if (!existsSync(output) || readFileSync(output, 'utf8') !== source) writeFileSync(output, source);
}

if (import.meta.main) writeAppleBatchReader();
