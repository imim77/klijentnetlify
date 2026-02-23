const DEFAULT_CHUNK_SIZE_BYTES = 64_000;
const DEFAULT_MAX_PARTITION_SIZE_BYTES = 1_000_000;

export class FileChunker {
    private readonly chunkSize: number;
    private readonly maxPartitionSize: number;
    private offset = 0;
    private partitionSize = 0;
    private inProgress = false;

    readonly file: File;
    private readonly onChunk: (chunk: ArrayBuffer) => void;
    private readonly onPartitionEnd: (offset: number) => void;

    constructor(
        file: File,
        onChunk: (chunk: ArrayBuffer) => void,
        onPartitionEnd: (offset: number) => void,
        opts?: {
            chunkSize?: number;
            maxPartitionSize?: number;
        },
    ) {
        this.file = file;
        this.onChunk = onChunk;
        this.onPartitionEnd = onPartitionEnd;
        this.chunkSize = opts?.chunkSize ?? DEFAULT_CHUNK_SIZE_BYTES;
        this.maxPartitionSize = opts?.maxPartitionSize ?? DEFAULT_MAX_PARTITION_SIZE_BYTES;
    }

    get progress(): number {
        if (this.file.size === 0) return 1;
        return this.offset / this.file.size;
    }

    get isFileEnd(): boolean {
        return this.offset >= this.file.size;
    }

    get bytesProcessed(): number {
        return this.offset;
    }

    async nextPartition(): Promise<{ offset: number; fileEnd: boolean }> {
        if (this.inProgress) {
            throw new Error('Partition read already in progress');
        }
        if (this.isFileEnd) {
            return { offset: this.offset, fileEnd: true };
        }

        this.inProgress = true;
        this.partitionSize = 0;

        try {
            while (!this.isFileEnd && !this.isPartitionEnd()) {
                const chunk = await this.readChunk();
                if (chunk.byteLength === 0) break;

                this.offset += chunk.byteLength;
                this.partitionSize += chunk.byteLength;
                this.onChunk(chunk);
            }

            if (!this.isFileEnd && this.isPartitionEnd()) {
                this.onPartitionEnd(this.offset);
            }

            return { offset: this.offset, fileEnd: this.isFileEnd };
        } finally {
            this.inProgress = false;
        }
    }

    async repeatPartition(): Promise<{ offset: number; fileEnd: boolean }> {
        if (this.inProgress) {
            throw new Error('Cannot repeat while partition read is in progress');
        }
        this.offset = Math.max(0, this.offset - this.partitionSize);
        return this.nextPartition();
    }

    private isPartitionEnd(): boolean {
        return this.partitionSize >= this.maxPartitionSize;
    }


    private async readChunk(): Promise<ArrayBuffer> {
        const chunk = this.file.slice(this.offset, this.offset + this.chunkSize);
        return await chunk.arrayBuffer();
    }
}

export type FileMeta = {
    size: number;
    mime?: string;
    name: string;
};

export type ReceivedFile = {
    name: string;
    mime: string;
    size: number;
    blob: Blob;
};

export class FileDigester {
    private readonly buffer: Blob[] = []; 
    private bytesReceivedInternal = 0;
    private settled = false;
    private readonly mime: string;

    private resolveDone!: (file: ReceivedFile) => void;
    private rejectDone!: (reason?: unknown) => void;

    readonly done: Promise<ReceivedFile>;

    // Removed the redundant callback parameter
    constructor(private readonly meta: FileMeta) {
        if (meta.size < 0) {
            throw new Error("meta.size must be >= 0");
        }

        this.mime = meta.mime && meta.mime.length > 0 ? meta.mime : "application/octet-stream";

        this.done = new Promise((resolve, reject) => {
            this.resolveDone = resolve;
            this.rejectDone = reject;
        });

        if (this.meta.size === 0) {
            this.complete();
        }
    }

    get bytesReceived() {
        return this.bytesReceivedInternal;
    }

    get totalBytes() {
        return this.meta.size;
    }

    get fileName() {
        return this.meta.name;
    }


    get progress(): number {
        if (this.meta.size === 0) return 1;
        return this.bytesReceivedInternal / this.meta.size;
    }

    unchunk(chunk: ArrayBuffer | Blob) {
        if (this.settled) return;


        const chunkSize = 'byteLength' in chunk ? chunk.byteLength : chunk.size;
        if (chunkSize === 0) return;

        const remaining = this.meta.size - this.bytesReceivedInternal;
        if (remaining <= 0) {
            this.complete();
            return;
        }

        if (chunkSize > remaining) {
            this.abort(new Error("Received chunk larger than expected remaining bytes"));
            return;
        }


        const blobChunk = chunk instanceof Blob ? chunk : new Blob([chunk]);
        this.buffer.push(blobChunk);
        
        this.bytesReceivedInternal += chunkSize;

        if (this.bytesReceivedInternal === this.meta.size) {
            this.complete();
        }
    }

    abort(reason?: unknown) {
        if (this.settled) return;

        this.settled = true;
        this.rejectDone(reason ?? new Error("File digest aborted"));
    }

    private complete(): void {
        if (this.settled) return;

        this.settled = true;
        const blob = new Blob(this.buffer, { type: this.mime });
        const file: ReceivedFile = {
            name: this.meta.name,
            mime: this.mime,
            size: this.meta.size,
            blob,
        };

        this.resolveDone(file);
    }
}