import { Session, type SessionStorage, type SessionTreeEntry } from '@earendil-works/pi-agent-core';
import type { MaicDocument } from '@openmaic/storage';

/**
 * An in-memory entry tree with the PostgreSQL handle's semantics: a leaf move
 * is an appended `leaf` entry whose parent is the old leaf, and every other
 * append moves the leaf to itself.
 */
export class MemoryTreeStorage implements SessionStorage {
  readonly entries: SessionTreeEntry[] = [];
  private leafId: string | null = null;
  private counter = 0;

  async getMetadata() {
    return { id: 'memory', createdAt: new Date(0).toISOString() };
  }
  async getLeafId() {
    return this.leafId;
  }
  async setLeafId(leafId: string | null) {
    this.entries.push({
      id: `leaf-${(this.counter += 1)}`,
      parentId: this.leafId,
      type: 'leaf',
      timestamp: new Date().toISOString(),
      targetId: leafId,
    } as SessionTreeEntry);
    this.leafId = leafId;
  }
  async createEntryId() {
    return `e${(this.counter += 1)}`;
  }
  async appendEntry(entry: SessionTreeEntry) {
    this.entries.push(entry);
    this.leafId =
      entry.type === 'leaf' ? ((entry as { targetId?: string | null }).targetId ?? null) : entry.id;
  }
  async getEntry(id: string) {
    return this.entries.find((entry) => entry.id === id);
  }
  async findEntries<TType extends SessionTreeEntry['type']>(type: TType) {
    return this.entries.filter((entry) => entry.type === type) as Array<
      Extract<SessionTreeEntry, { type: TType }>
    >;
  }
  async getLabel() {
    return undefined;
  }
  async getPathToRoot(leafId: string | null) {
    const path: SessionTreeEntry[] = [];
    let current = leafId === null ? undefined : await this.getEntry(leafId);
    while (current) {
      path.unshift(current);
      current = current.parentId === null ? undefined : await this.getEntry(current.parentId);
    }
    return path;
  }
  async getEntries() {
    return [...this.entries];
  }
}

export function memorySession(): { session: Session; storage: MemoryTreeStorage } {
  const storage = new MemoryTreeStorage();
  return { session: new Session(storage), storage };
}

/** Append a user frame tagged with its durable message sequence, as the runner does. */
export async function appendUser(session: Session, text: string, seq?: number): Promise<string> {
  return session.appendMessage({
    role: 'user',
    content: text,
    timestamp: Date.now(),
    ...(seq ? { openmaicDurableUserMessageSeq: seq } : {}),
  } as never);
}

export async function appendAssistant(session: Session, text: string): Promise<string> {
  return session.appendMessage({
    role: 'assistant',
    content: [{ type: 'text', text }],
    stopReason: 'stop',
    timestamp: Date.now(),
  } as never);
}

/** A document store double holding whole documents, as the owner-bound store saves them. */
export class MemoryDocuments {
  readonly documents = new Map<string, MaicDocument>();
  saves = 0;
  private failingSave: number | null = null;

  /** Make the `nth` save from now throw, once (a failed write saves nothing). */
  failSave(nth: number): void {
    this.failingSave = this.saves + nth;
  }

  async loadDocument(stageId: string): Promise<MaicDocument | null> {
    const document = this.documents.get(stageId);
    return document ? structuredClone(document) : null;
  }
  async saveDocument(document: MaicDocument): Promise<void> {
    this.saves += 1;
    if (this.saves === this.failingSave) {
      this.failingSave = null;
      throw new Error('save failed');
    }
    this.documents.set(document.stage.id, structuredClone(document));
  }
}

export function course(
  stageId: string,
  pages: Array<{ id: string; title: string; extra?: string }>,
): MaicDocument {
  return {
    stage: { id: stageId, name: 'Photosynthesis', createdAt: 1, updatedAt: 1 } as never,
    scenes: pages.map((page, order) => ({
      id: page.id,
      stageId,
      type: 'slide',
      title: page.title,
      order,
      content: { extra: page.extra ?? null },
    })) as never,
  };
}

export function titles(document: MaicDocument | null | undefined): string[] {
  return (
    (document?.scenes ?? []) as unknown as Array<{
      title: string;
      content: { extra: string | null };
    }>
  ).map((scene) => (scene.content.extra ? `${scene.title}+${scene.content.extra}` : scene.title));
}
