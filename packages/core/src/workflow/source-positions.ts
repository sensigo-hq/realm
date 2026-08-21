// source-positions.ts — maps a workflow's semantic coordinates (`steps.s1.execution`) to where
// that key physically sits in the YAML the author wrote (issue #392).
//
// WHY VENDORED. This is the js-yaml-source-map pattern, ~100 audited lines in-repo rather than a
// new dependency: the supply-chain posture (#238) prefers code we can read over a package we
// cannot. It rides the parser already in use — `yaml.load` accepts a `listener`, so the map is
// built during the SAME parse the loader already performs. No second parse, no parser swap, no
// dependency change.
//
// THE INVARIANT, and it is the whole design: a position is ABSENT or CORRECT, never guessed. A
// wrong line number is worse than no line number — it sends an author to the wrong place with
// full confidence, and they trust it because a machine printed it. Every ambiguity below resolves
// to "record nothing".
//
// HOW THE PARSER REPORTS ITSELF (verified by execution against js-yaml 4.3.1, not from docs):
//   - `open`  fires when a node STARTS. `state.line`/`state.position` point at that start — but
//     `state.result` still holds the PREVIOUS node's value. It is stale and must never be read.
//   - `close` fires when a node ENDS. `state.result` is now this node's value, and the position
//     points at its END.
//   - Coordinates are 0-BASED. They are converted to 1-based exactly once, at the map boundary
//     below, so no rendering site ever has to remember.
// So a node's start comes from its `open` and its value from its matching `close`, and the stream
// is balanced — which is what makes the stack below correct.
import type { State } from 'js-yaml';

/**
 * Where a key sits in the source. 1-based. `endColumn` is exclusive — one past the last character
 * (the editor convention); all other bounds inclusive.
 */
export interface SourcePosition {
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
}

/**
 * Resolves a semantic path to its position in the source, or `undefined` if it cannot.
 *
 * The path is a SEQUENCE OF SEGMENTS — `['steps', 'my_step', 'execution']` — never a joined
 * string, and that is a correctness requirement rather than a style preference. A dotted path
 * aliases: a step literally named `a.b` and a field `b` on a step named `a` both flatten to
 * `steps.a.b`, and last-write-wins hands one of them the OTHER's line. That is lawful YAML
 * producing a confidently wrong position — the one outcome this module exists to make impossible.
 *
 * No separator fixes it. NUL does not: js-yaml parses `"a\0b"` into a key that CONTAINS a literal
 * NUL, so a NUL-join aliases exactly as the dot did. There is no character a YAML key cannot hold,
 * so only structure can carry the distinction.
 */
export interface SourcePositionMap {
  posOf(segments: readonly string[]): SourcePosition | undefined;
}

/** A node reconstructed from one open/close pair. */
interface Node {
  kind: string | null;
  result: unknown;
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
  children: Node[];
}

/** A node whose close has not arrived yet. */
interface Frame {
  startLine: number;
  startColumn: number;
  children: Node[];
}

const EMPTY_MAP: SourcePositionMap = { posOf: () => undefined };

/**
 * The map's internal key. `JSON.stringify` of a string array is injective — the escaping is
 * deterministic and the array brackets/commas are part of the encoding — so two different segment
 * sequences can never produce the same key. `['a.b']` encodes as `["a.b"]` and `['a','b']` as
 * `["a","b"]`; there is no input that collapses them.
 */
function keyOf(segments: readonly string[]): string {
  return JSON.stringify(segments);
}

/** A map that resolves nothing — for callers with no source text to map against. */
export function emptySourcePositionMap(): SourcePositionMap {
  return EMPTY_MAP;
}

/**
 * Collects positions during a parse. Create one, hand `listener` to `yaml.load`, then call
 * `finish()`. One instance per parse — there is no module state, so concurrent loads cannot see
 * each other's positions.
 */
export function createSourcePositionCollector(): {
  listener: (event: 'open' | 'close', state: State) => void;
  finish: () => SourcePositionMap;
} {
  // The root frame is a container for whatever closes at the top level; the document's own node
  // lands in its children.
  const stack: Frame[] = [{ startLine: 0, startColumn: 0, children: [] }];

  return {
    listener(event, state) {
      if (event === 'open') {
        stack.push({
          startLine: state.line,
          startColumn: state.position - state.lineStart,
          children: [],
        });
        return;
      }
      // A close with nothing open would mean the stream is not balanced. It is, on every input
      // this parser accepts — but if it ever were not, dropping the event is the behaviour that
      // preserves the invariant.
      if (stack.length <= 1) return;
      const frame = stack.pop() as Frame;
      const parent = stack[stack.length - 1] as Frame;
      parent.children.push({
        kind: state.kind,
        result: state.result,
        startLine: frame.startLine,
        startColumn: frame.startColumn,
        endLine: state.line,
        endColumn: state.position - state.lineStart,
        children: frame.children,
      });
    },

    finish() {
      const positions = new Map<string, SourcePosition>();
      // The document node is the last thing to close at the top level.
      const root = stack[0]?.children[stack[0].children.length - 1];
      if (root !== undefined) collect(root, [], positions);
      return {
        posOf: (segments) => positions.get(keyOf(segments)),
      };
    },
  };
}

/**
 * Walks a mapping and records one position per key, then descends.
 *
 * THE STRICT PAIRING RULE. A block mapping's immediate children arrive as key, value, key, value
 * — so `children.length` must be exactly twice the key count, and each even child must BE the
 * corresponding key. Anything else means this node's children do not line up with its keys the
 * way they normally do: a flow mapping with a valueless key, a merge key that expanded, an anchor
 * replayed from elsewhere in the document. In every one of those the positions would be off by
 * some amount that is not knowable from here.
 *
 * So on any mismatch this records NOTHING for the whole mapping — not a best guess for the keys
 * that happened to line up. That is the absent-never-wrong invariant, and it is deliberately
 * blunt: the cost is a missing line number on an exotic shape, and the alternative is a confident
 * wrong one on the same shape.
 */
function collect(node: Node, path: readonly string[], into: Map<string, SourcePosition>): void {
  // Only structural nodes are walked. Anchor replays surface as events nested inside scalars,
  // which have no keys to map and are never descended into.
  if (node.kind !== 'mapping') return;
  if (typeof node.result !== 'object' || node.result === null || Array.isArray(node.result)) return;

  const keys = Object.keys(node.result as Record<string, unknown>);
  if (node.children.length !== 2 * keys.length) return;
  for (let i = 0; i < keys.length; i++) {
    if ((node.children[2 * i] as Node).result !== keys[i]) return;
  }

  for (let i = 0; i < keys.length; i++) {
    const keyNode = node.children[2 * i] as Node;
    const valueNode = node.children[2 * i + 1] as Node;
    const childPath = [...path, keys[i] as string];
    // +1 on every coordinate: this is the ONE place 0-based parser state becomes 1-based
    // human/agent coordinates.
    into.set(keyOf(childPath), {
      line: keyNode.startLine + 1,
      column: keyNode.startColumn + 1,
      endLine: keyNode.endLine + 1,
      endColumn: keyNode.endColumn + 1,
    });
    collect(valueNode, childPath, into);
  }
}
