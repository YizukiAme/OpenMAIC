import { describe, expect, it } from 'vitest';

import {
  COURSE_VERSIONS_ENTRY,
  REPLY_VARIANT_ENTRY,
  beforeSwitchEntryOf,
  courseVersionsOnPath,
  findUserEntry,
  latestLeafUnder,
  parseBranchRequest,
  planBranchMove,
  replyVariantChild,
  type TreeEntry,
} from '@/lib/server/course-versions/tree';

const SEQ = 'openmaicDurableUserMessageSeq';

function user(id: string, parentId: string | null, seq?: number): TreeEntry {
  return {
    id,
    parentId,
    type: 'message',
    message: { role: 'user', content: id, ...(seq ? { [SEQ]: seq } : {}) },
  };
}
function assistant(id: string, parentId: string | null): TreeEntry {
  return { id, parentId, type: 'message', message: { role: 'assistant', content: [] } };
}
function versions(id: string, parentId: string | null, list: [string, string][]): TreeEntry {
  return {
    id,
    parentId,
    type: 'custom',
    customType: COURSE_VERSIONS_ENTRY,
    data: {
      phase: 'after_run',
      versions: list.map(([stageId, versionId]) => ({ stageId, versionId })),
    },
  };
}
function variant(id: string, parentId: string, requestSeq: number): TreeEntry {
  return { id, parentId, type: 'custom', customType: REPLY_VARIANT_ENTRY, data: { requestSeq } };
}
function leaf(id: string, parentId: string | null, targetId: string | null): TreeEntry {
  return { id, parentId, type: 'leaf', targetId };
}

/**
 * The shape the runner writes, as in the issue's example:
 *
 *   u0 (opening) → a0 → v1 → b3 (before ③) → u3 (seq 7) → a3 → v3
 *                                              ├ r20 (regenerate #20) → a3b → v3b
 *                                  └ u3e (edited ③, seq 30) → a3e
 */
function exampleTree(): TreeEntry[] {
  return [
    user('u0', null),
    assistant('a0', 'u0'),
    versions('v1', 'a0', [['stage', 'cv-1']]),
    versions('b3', 'v1', [['stage', 'cv-1h']]),
    user('u3', 'b3', 7),
    assistant('a3', 'u3'),
    versions('v3', 'a3', [['stage', 'cv-video']]),
    leaf('l1', 'v3', 'u3'),
    variant('r20', 'u3', 20),
    assistant('a3b', 'r20'),
    versions('v3b', 'a3b', [['stage', 'cv-anim']]),
    leaf('l2', 'v3b', 'b3'),
    user('u3e', 'b3', 30),
    assistant('a3e', 'u3e'),
  ];
}

describe('course versions on a path', () => {
  it('takes the nearest entry per course', () => {
    const tree = exampleTree();
    const byId = new Map(tree.map((entry) => [entry.id, entry]));
    const path = ['u0', 'a0', 'v1', 'b3', 'u3', 'a3', 'v3'].map((id) => byId.get(id)!);
    expect(courseVersionsOnPath(path)).toEqual(new Map([['stage', 'cv-video']]));
    expect(courseVersionsOnPath(path.slice(0, 5))).toEqual(new Map([['stage', 'cv-1h']]));
  });

  it('ignores entries that are not course versions', () => {
    expect(courseVersionsOnPath([user('u', null), variant('r', 'u', 3)])).toEqual(new Map());
  });
});

describe('finding the user frame a request names', () => {
  it('finds a durable message by its sequence and the opening prompt by 0', () => {
    const tree = exampleTree();
    expect(findUserEntry(tree, 7)?.id).toBe('u3');
    expect(findUserEntry(tree, 30)?.id).toBe('u3e');
    expect(findUserEntry(tree, 0)?.id).toBe('u0');
    expect(findUserEntry(tree, 99)).toBeUndefined();
  });
});

describe('where a branch continues', () => {
  it('is the most recently written end of the subtree, ignoring cursor entries', () => {
    const tree = exampleTree();
    expect(latestLeafUnder(tree, 'u3')).toBe('v3b');
    expect(latestLeafUnder(tree, 'a3')).toBe('v3');
    expect(latestLeafUnder(tree, 'u3e')).toBe('a3e');
  });

  it('tells the original reply from regenerated ones', () => {
    const tree = exampleTree();
    expect(replyVariantChild(tree, 'u3', 'orig')?.id).toBe('a3');
    expect(replyVariantChild(tree, 'u3', 20)?.id).toBe('r20');
    expect(replyVariantChild(tree, 'u3', 21)).toBeUndefined();
  });
});

describe('planning a branch move', () => {
  const tree = exampleTree();

  it('regenerate moves onto the user frame and marks a new reply', () => {
    expect(planBranchMove(tree, { op: 'regenerate', targetSeq: 7 }, 41)).toEqual({
      kind: 'move',
      leafId: 'u3',
      replyVariant: { requestSeq: 41 },
    });
  });

  it('regenerate applied again answers under the marker it already wrote', () => {
    const again = [...tree, variant('r50', 'u3', 50)];
    expect(planBranchMove(again, { op: 'regenerate', targetSeq: 7 }, 50)).toEqual({
      kind: 'move',
      leafId: 'r50',
    });
  });

  it('edit moves to the versions taken just before the message', () => {
    expect(planBranchMove(tree, { op: 'edit', targetSeq: 7 }, 42)).toEqual({
      kind: 'move',
      leafId: 'b3',
    });
  });

  it('refuses to edit the opening prompt', () => {
    expect(planBranchMove(tree, { op: 'edit', targetSeq: 0 }, 43)).toEqual({
      kind: 'reject',
      reason: 'opening_message_not_editable',
    });
  });

  it('also refuses the durable opener when a before-run course version precedes it', () => {
    const attached = [versions('before', null, [['stage', 'v1']]), user('opener', 'before', 1)];
    for (const targetSeq of [0, 1]) {
      expect(planBranchMove(attached, { op: 'edit', targetSeq }, 3)).toEqual({
        kind: 'reject',
        reason: 'opening_message_not_editable',
      });
    }
  });

  it('switches to a message or to one of its replies', () => {
    expect(planBranchMove(tree, { op: 'switch', targetSeq: 7 }, 44)).toEqual({
      kind: 'move',
      leafId: 'v3b',
    });
    expect(planBranchMove(tree, { op: 'switch', targetSeq: 7, variant: 'orig' }, 45)).toEqual({
      kind: 'move',
      leafId: 'v3',
    });
    expect(planBranchMove(tree, { op: 'switch', targetSeq: 30 }, 46)).toEqual({
      kind: 'move',
      leafId: 'a3e',
    });
    expect(planBranchMove(tree, { op: 'switch', targetSeq: 7, variant: 9 }, 47)).toEqual({
      kind: 'reject',
      reason: 'variant_not_found',
    });
  });

  it('returns to the reply last selected inside a nested fork', () => {
    // Of message 7's replies, the older original was selected before the
    // user moved to edited message 30. Its departure snapshot remembers that.
    const nested = [
      ...tree,
      versions('depart-original', 'v3', [['stage', 'cv-original-hand-edit']]),
      leaf('to-edited', 'depart-original', 'a3e'),
      versions('depart-edited', 'a3e', [['stage', 'cv-edit']]),
    ];
    expect(planBranchMove(nested, { op: 'switch', targetSeq: 7 }, 68)).toEqual({
      kind: 'move',
      leafId: 'depart-original',
    });
  });

  it('rejects a target that is not in the tree', () => {
    expect(planBranchMove(tree, { op: 'regenerate', targetSeq: 5 }, 48)).toEqual({
      kind: 'reject',
      reason: 'target_not_found',
    });
  });
});

describe('a request that already started', () => {
  it('is found by the before-switch entry it wrote', () => {
    const started: TreeEntry = {
      id: 's25',
      parentId: 'v3b',
      type: 'custom',
      customType: COURSE_VERSIONS_ENTRY,
      data: { phase: 'before_switch', versions: [], requestSeq: 25 },
    };
    expect(beforeSwitchEntryOf([...exampleTree(), started], 25)?.id).toBe('s25');
    expect(beforeSwitchEntryOf([...exampleTree(), started], 26)).toBeUndefined();
    expect(beforeSwitchEntryOf(exampleTree(), 25)).toBeUndefined();
  });
});

describe('parsing a branch request', () => {
  it('accepts the three operations and nothing else', () => {
    expect(parseBranchRequest({ op: 'edit', targetSeq: 3 })).toEqual({ op: 'edit', targetSeq: 3 });
    expect(parseBranchRequest({ op: 'switch', targetSeq: 3, variant: 'orig' })).toEqual({
      op: 'switch',
      targetSeq: 3,
      variant: 'orig',
    });
    expect(parseBranchRequest({ op: 'delete', targetSeq: 3 })).toBeNull();
    expect(parseBranchRequest({ op: 'edit', targetSeq: -1 })).toBeNull();
    expect(parseBranchRequest({ op: 'switch', targetSeq: 3, variant: 0 })).toBeNull();
    expect(parseBranchRequest(null)).toBeNull();
  });
});
