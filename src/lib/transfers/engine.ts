// One file on its way between this device and the Mac, a piece at a time, through the same
// requests everything else uses. Nothing here touches the page, so it runs under test as it is.

import type {
  FsDownloadParams,
  FsDownloadResult,
  FsUploadBeginParams,
  FsUploadBeginResult,
  FsUploadChunkParams,
  FsUploadChunkResult,
  FsUploadEndResult,
  UploadConflictChoice,
  UploadDestination,
} from "../../../shared/protocol.ts";
import { pieceLength, TRANSFER_REQUEST_TIMEOUT_MS } from "../../../shared/transfers.ts";
import { decodeBase64, encodeBase64 } from "./base64.ts";

export type Rpc = <T>(method: string, params: object, timeoutMs?: number) => Promise<T>;

export type TransferLimits = { maxBytes: number; chunkBytes: number };

/**
 * Why a transfer stopped. `code` is one of the protocol's error codes, or one of this side's own:
 * `cancelled`, and `changed` for a file that was written to on the Mac while it was being read.
 */
export class TransferFailure extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export type TransferHooks = {
  rpc: Rpc;
  limits: TransferLimits;
  signal: AbortSignal;
  onProgress: (moved: number, total: number) => void;
  /** Called with true when the Mac cannot be reached, and with false when the transfer goes on. */
  onPaused: (paused: boolean) => void;
  /** Resolves once the Mac can be asked again, and rejects when `signal` aborts first. */
  waitForMac: (signal: AbortSignal) => Promise<void>;
};

export type UploadSource = {
  size: number;
  /** The bytes from `start` up to, not including, `end`. */
  read: (start: number, end: number) => Promise<Uint8Array>;
};

export type UploadRequest = {
  source: UploadSource;
  destination: UploadDestination;
  name: string;
  onConflict: UploadConflictChoice;
};

/**
 * A finished download. Each piece becomes a Blob as soon as it arrives and its bytes are let go,
 * so a large file is held once, by the browser, and never also as base64 or as a copy.
 */
export type Downloaded = { blob: Blob; size: number; mtime: number };

/** A lost connection is waited out; a Mac that keeps silent is asked this many times in all. */
const TIMEOUT_TRIES = 3;
/** Losing the Mac again and again without a single piece getting through ends the transfer. */
const STALLED_TRIES = 6;

const cancelled = () => new TransferFailure("cancelled", "Cancelled");

function failureOf(error: unknown): TransferFailure {
  if (error instanceof TransferFailure) return error;
  const code = (error as { code?: unknown } | null)?.code;
  return new TransferFailure(
    typeof code === "string" ? code : "failed",
    error instanceof Error ? error.message : "",
  );
}

/** The answer to a request, or `cancelled` as soon as the transfer is, whichever comes first. */
function untilAborted<T>(answer: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(cancelled());
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    answer.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

/**
 * Asks the Mac one thing on behalf of a transfer. A connection that is gone, on either side of the
 * relay, pauses the transfer until it is back and then asks again; every request of a transfer may
 * be repeated, which is what the protocol's rules for pieces are for.
 */
async function ask<T>(
  hooks: TransferHooks,
  method: string,
  params: object,
  timeoutMs?: number,
): Promise<T> {
  let timeouts = 0;
  let stalls = 0;
  for (;;) {
    if (hooks.signal.aborted) throw cancelled();
    try {
      return await untilAborted(hooks.rpc<T>(method, params, timeoutMs), hooks.signal);
    } catch (error) {
      const failure = failureOf(error);
      if (failure.code === "disconnected" || failure.code === "agent_offline") {
        if (++stalls >= STALLED_TRIES) throw failure;
        hooks.onPaused(true);
        try {
          await hooks.waitForMac(hooks.signal);
        } catch {
          throw cancelled();
        }
        hooks.onPaused(false);
      } else if (failure.code === "timeout") {
        if (++timeouts >= TIMEOUT_TRIES) throw failure;
      } else {
        throw failure;
      }
    }
  }
}

/**
 * Reads a file from the Mac. The first piece says how long the file is and when it last changed;
 * every later piece is asked for on that condition, so a file that is written to in the meantime
 * ends the download instead of arriving as a mix of two versions.
 */
export async function download(hooks: TransferHooks, path: string): Promise<Downloaded> {
  const { maxBytes, chunkBytes } = hooks.limits;
  const parts: Blob[] = [];
  let size: number | null = null;
  let mtime: number | null = null;
  let offset = 0;
  do {
    const params: FsDownloadParams = {
      path,
      offset,
      length: size === null ? chunkBytes : pieceLength(offset, size, chunkBytes),
      expected_size: size,
      expected_mtime: mtime,
    };
    let piece: FsDownloadResult;
    try {
      piece = await ask<FsDownloadResult>(
        hooks,
        "fs.download",
        params,
        TRANSFER_REQUEST_TIMEOUT_MS,
      );
    } catch (error) {
      const failure = failureOf(error);
      if (failure.code === "conflict") throw new TransferFailure("changed", failure.message);
      throw failure;
    }
    if (size === null) {
      size = piece.size;
      mtime = piece.mtime;
      if (size > maxBytes) {
        throw new TransferFailure("too_large", `The file is ${size} bytes, over the limit`);
      }
    }
    let bytes: Uint8Array;
    try {
      bytes = decodeBase64(piece.data);
    } catch {
      throw new TransferFailure("failed", "Your Mac sent a piece that could not be read");
    }
    if (bytes.length !== pieceLength(offset, size, chunkBytes)) {
      throw new TransferFailure("failed", "Your Mac sent a piece of the wrong length");
    }
    parts.push(new Blob([bytes as BlobPart]));
    offset += bytes.length;
    hooks.onProgress(offset, size);
  } while (offset < size);
  return { blob: new Blob(parts), size, mtime: mtime ?? 0 };
}

/**
 * Writes a file to the Mac: announce it, send its pieces in order, and ask for it to be put in
 * place. A piece whose answer was lost is sent again as it was, which the Mac takes as the same
 * piece. Whatever goes wrong after the announcement, the Mac is told to forget the upload.
 */
export async function upload(
  hooks: TransferHooks,
  request: UploadRequest,
): Promise<FsUploadEndResult> {
  const { maxBytes, chunkBytes } = hooks.limits;
  const { source } = request;
  if (source.size > maxBytes) {
    throw new TransferFailure("too_large", `The file is ${source.size} bytes, over the limit`);
  }
  const begin: FsUploadBeginParams = {
    destination: request.destination,
    name: request.name,
    size: source.size,
    on_conflict: request.onConflict,
  };
  const { upload_id: id } = await ask<FsUploadBeginResult>(hooks, "fs.upload_begin", begin);
  try {
    let offset = 0;
    while (offset < source.size) {
      const end = offset + pieceLength(offset, source.size, chunkBytes);
      const bytes = await source.read(offset, end);
      if (bytes.length !== end - offset) {
        throw new TransferFailure("failed", "The file changed on this device while it was sent");
      }
      const piece: FsUploadChunkParams = { upload_id: id, offset, data: encodeBase64(bytes) };
      const { received } = await ask<FsUploadChunkResult>(
        hooks,
        "fs.upload_chunk",
        piece,
        TRANSFER_REQUEST_TIMEOUT_MS,
      );
      if (received < end) {
        throw new TransferFailure("failed", "Your Mac lost part of the upload");
      }
      offset = end;
      hooks.onProgress(offset, source.size);
    }
    return await ask<FsUploadEndResult>(
      hooks,
      "fs.upload_end",
      { upload_id: id },
      TRANSFER_REQUEST_TIMEOUT_MS,
    );
  } catch (error) {
    void hooks.rpc("fs.upload_cancel", { upload_id: id }).catch(() => {});
    throw failureOf(error);
  }
}
