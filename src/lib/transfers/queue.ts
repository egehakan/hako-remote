// The transfers this device has asked for, and what state each is in. Those of one group run one
// after another, so a second file never competes with the first for the same connection; groups
// run side by side, so a picture for a terminal does not wait behind a large file in Files.

import type { FsUploadEndResult, UploadDestination } from "../../../shared/protocol.ts";
import {
  type Downloaded,
  download,
  type Rpc,
  TransferFailure,
  type TransferHooks,
  type TransferLimits,
  upload,
  type UploadRequest,
  type UploadSource,
} from "./engine.ts";

export type TransferState =
  /** A large download that waits for the owner to say yes, having seen its size. */
  | "confirm"
  | "queued"
  | "running"
  /** The Mac cannot be reached. The transfer goes on by itself when it can. */
  | "paused"
  /** An upload whose name is taken, waiting to hear whether to replace, keep both or give up. */
  | "asking"
  | "done"
  | "failed"
  | "cancelled";

export type Transfer = {
  id: number;
  group: string;
  direction: "download" | "upload";
  name: string;
  /** In bytes; null for a download until its first piece has said. */
  total: number | null;
  moved: number;
  state: TransferState;
  error: { code: string; message: string } | null;
  /** Where a finished upload is on the Mac. */
  uploaded: FsUploadEndResult | null;
  /** The bytes of a finished download. */
  downloaded: Downloaded | null;
  /** True once a finished download has been handed to this device. */
  delivered: boolean;
};

export type ConflictAnswer = "replace" | "rename" | "cancel";

type Job = {
  work: { kind: "download"; path: string } | { kind: "upload"; request: UploadRequest };
  onDone: ((transfer: Transfer) => void) | undefined;
  controller: AbortController | null;
};

export type QueueDeps = {
  rpc: Rpc;
  waitForMac: TransferHooks["waitForMac"];
  limits: () => TransferLimits;
};

type DownloadOrder = {
  group: string;
  path: string;
  name: string;
  /** What the folder's listing said, when there was one to say it. */
  size?: number | null;
  /** True to wait in "confirm" until the owner has seen the size and said yes. */
  askFirst?: boolean;
  onDone?: (transfer: Transfer) => void;
};

type UploadOrder = {
  group: string;
  source: UploadSource;
  destination: UploadDestination;
  name: string;
  onDone?: (transfer: Transfer) => void;
};

const ENDED: readonly TransferState[] = ["done", "failed", "cancelled"];

export class TransferQueue {
  private readonly deps: QueueDeps;
  private items: readonly Transfer[] = [];
  private readonly jobs = new Map<number, Job>();
  private readonly listeners = new Set<() => void>();
  private nextId = 1;

  constructor(deps: QueueDeps) {
    this.deps = deps;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): readonly Transfer[] => this.items;

  get(id: number): Transfer | null {
    return this.items.find((item) => item.id === id) ?? null;
  }

  addDownload(order: DownloadOrder): number {
    const size = order.size ?? null;
    return this.add(
      { group: order.group, direction: "download", name: order.name, total: size },
      { work: { kind: "download", path: order.path }, onDone: order.onDone, controller: null },
      size,
      order.askFirst === true,
    );
  }

  addUpload(order: UploadOrder): number {
    const request: UploadRequest = {
      source: order.source,
      destination: order.destination,
      name: order.name,
      onConflict: "fail",
    };
    return this.add(
      { group: order.group, direction: "upload", name: order.name, total: order.source.size },
      { work: { kind: "upload", request }, onDone: order.onDone, controller: null },
      order.source.size,
    );
  }

  /** The owner's yes for a large download that waited to be confirmed. */
  confirm(id: number): void {
    const item = this.get(id);
    if (!item || item.state !== "confirm") return;
    this.update(id, { state: "queued" });
    this.pump(item.group);
  }

  /** Stops a transfer wherever it is. A finished one stays finished. */
  cancel(id: number): void {
    const item = this.get(id);
    if (!item || ENDED.includes(item.state)) return;
    this.update(id, { state: "cancelled" });
    this.jobs.get(id)?.controller?.abort();
    this.pump(item.group);
  }

  /** Starts a failed or cancelled transfer again, from its first byte. */
  retry(id: number): void {
    const item = this.get(id);
    if (!item || (item.state !== "failed" && item.state !== "cancelled")) return;
    this.update(id, { state: "queued", error: null, moved: 0 });
    this.pump(item.group);
  }

  /** The owner's answer for an upload whose name is taken. */
  answer(id: number, choice: ConflictAnswer): void {
    const item = this.get(id);
    const job = this.jobs.get(id);
    if (!item || item.state !== "asking" || job?.work.kind !== "upload") return;
    if (choice === "cancel") {
      this.update(id, { state: "cancelled" });
      return;
    }
    job.work.request.onConflict = choice;
    this.update(id, { state: "queued" });
    this.pump(item.group);
  }

  markDelivered(id: number): void {
    this.update(id, { delivered: true });
  }

  /** Takes an ended transfer off the list, and with it the bytes a download holds. */
  dismiss(id: number): void {
    const item = this.get(id);
    if (!item || !ENDED.includes(item.state)) return;
    this.jobs.delete(id);
    this.set(this.items.filter((other) => other.id !== id));
  }

  /** Stops everything a group still has going, and forgets the group. */
  drop(group: string): void {
    for (const item of this.items) {
      if (item.group === group) this.jobs.get(item.id)?.controller?.abort();
    }
    for (const item of this.items) if (item.group === group) this.jobs.delete(item.id);
    this.set(this.items.filter((item) => item.group !== group));
  }

  private add(
    described: Pick<Transfer, "group" | "direction" | "name" | "total">,
    job: Job,
    size: number | null,
    askFirst = false,
  ): number {
    const id = this.nextId++;
    const { maxBytes } = this.deps.limits();
    // A file that is too large is told so before a byte of it is sent, or asked for.
    const tooLarge = size !== null && size > maxBytes;
    this.jobs.set(id, job);
    this.set([
      ...this.items,
      {
        ...described,
        id,
        moved: 0,
        state: tooLarge ? "failed" : askFirst ? "confirm" : "queued",
        error: tooLarge ? { code: "too_large", message: "" } : null,
        uploaded: null,
        downloaded: null,
        delivered: false,
      },
    ]);
    this.pump(described.group);
    return id;
  }

  private pump(group: string): void {
    const mine = this.items.filter((item) => item.group === group);
    if (mine.some((item) => item.state === "running" || item.state === "paused")) return;
    const next = mine.find((item) => item.state === "queued");
    if (next) void this.run(next.id);
  }

  private async run(id: number): Promise<void> {
    const job = this.jobs.get(id);
    const item = this.get(id);
    if (!job || !item) return;
    const controller = new AbortController();
    job.controller = controller;
    this.update(id, { state: "running", error: null, moved: 0 });
    /** A transfer that was cancelled or dismissed has nothing more to say. */
    const active = () => !controller.signal.aborted && this.get(id) !== null;
    const hooks: TransferHooks = {
      rpc: this.deps.rpc,
      limits: this.deps.limits(),
      signal: controller.signal,
      waitForMac: this.deps.waitForMac,
      onProgress: (moved, total) => {
        if (active()) this.update(id, { moved, total });
      },
      onPaused: (paused) => {
        if (active()) this.update(id, { state: paused ? "paused" : "running" });
      },
    };
    try {
      if (job.work.kind === "download") {
        const downloaded = await download(hooks, job.work.path);
        if (!active()) return;
        this.update(id, { state: "done", downloaded, total: downloaded.size });
      } else {
        const uploaded = await upload(hooks, job.work.request);
        if (!active()) return;
        this.update(id, { state: "done", uploaded, moved: uploaded.size, total: uploaded.size });
      }
      const finished = this.get(id);
      if (finished) job.onDone?.(finished);
    } catch (error) {
      if (!active()) return;
      const failure =
        error instanceof TransferFailure ? error : new TransferFailure("failed", String(error));
      const taken =
        job.work.kind === "upload" &&
        job.work.request.onConflict === "fail" &&
        failure.code === "conflict";
      if (taken) this.update(id, { state: "asking", moved: 0 });
      else if (failure.code === "cancelled") this.update(id, { state: "cancelled" });
      else {
        this.update(id, {
          state: "failed",
          error: { code: failure.code, message: failure.message },
        });
      }
    } finally {
      // A retry may already have put the next attempt's controller here.
      if (job.controller === controller) job.controller = null;
      this.pump(item.group);
    }
  }

  private update(id: number, change: Partial<Transfer>): void {
    if (!this.items.some((item) => item.id === id)) return;
    this.set(this.items.map((item) => (item.id === id ? { ...item, ...change } : item)));
  }

  private set(items: readonly Transfer[]): void {
    this.items = items;
    for (const listener of this.listeners) listener();
  }
}
