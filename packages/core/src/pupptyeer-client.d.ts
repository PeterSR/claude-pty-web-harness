// Ambient types for the untyped pupptyeer Node client (index.mjs).
// Mirrors the public surface of @petersr/pupptyeer-client.
declare module "@petersr/pupptyeer-client" {
  export interface SessionInfo {
    id: string;
    command: string;
    args?: string[];
    cwd?: string;
    cols: number;
    rows: number;
    created: string;
    last_activity: string;
    attached: number;
    alive: boolean;
  }

  export interface NewSessionOptions {
    command: string;
    args?: string[];
    cwd?: string;
    env?: Record<string, string>;
    cols?: number;
    rows?: number;
  }

  export interface CaptureOptions {
    /** Wait for the screen to be quiet for this many ms before capturing. */
    settleMs?: number;
    /** Cap on how long to wait for the quiet window. */
    timeoutMs?: number;
  }

  export interface RenderedScreen {
    cols: number;
    rows: number;
    lines: string[];
    cursor: { row: number; col: number; visible: boolean };
    altScreen: boolean;
  }

  export class PupptyeerClient {
    static connect(path: string): Promise<PupptyeerClient>;
    newSession(options: NewSessionOptions): Promise<string>;
    listSessions(): Promise<SessionInfo[]>;
    attach(session: string, options?: { cols?: number; rows?: number }): Promise<void>;
    detach(session: string): void;
    writePane(session: string, text: string): void;
    writeBytes(session: string, buf: Buffer): void;
    capturePane(session: string, options?: CaptureOptions): Promise<Buffer>;
    /** Daemon-rendered visible grid (since pupptyeer 0.2.0). */
    captureScreen(session: string, options?: CaptureOptions): Promise<RenderedScreen>;
    resize(session: string, cols: number, rows: number): void;
    kill(session: string): Promise<void>;
    gc(maxIdleSeconds: number): Promise<SessionInfo[]>;
    onOutput(session: string, fn: (bytes: Buffer) => void): void;
    onEvent(fn: (msg: Record<string, unknown>) => void): void;
    close(): void;
  }
}
