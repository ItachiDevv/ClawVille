/** Trusted coordinator values. Never derive this authority from a task brief. */
export interface IsolatedTaskBinding {
  readonly jobId: string;
  readonly avatarId: string;
  readonly taskId: string;
  readonly attemptId: string;
  readonly generation: number;
  readonly reservationId: string;
  readonly callId: string;
  readonly model: string;
  readonly promptHash: string;
  readonly maxInputTokens: number;
  readonly maxOutputTokens: number;
  /** Absolute Unix milliseconds. */
  readonly deadlineMs: number;
}

export interface IsolatedTaskProxyRequest {
  readonly binding: Readonly<IsolatedTaskBinding>;
  readonly prompt: string;
}

export interface IsolatedTaskProxyResponse {
  readonly callId: string;
  readonly model: string;
  readonly promptHash: string;
  readonly text: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

/** The trusted transport owns endpoint/authentication; the brief supplies neither. */
export interface IsolatedTaskProxy {
  generate(request: IsolatedTaskProxyRequest, signal: AbortSignal): Promise<IsolatedTaskProxyResponse>;
}

export interface IsolatedTaskRuntimeConfig {
  readonly executionProfile: {
    readonly kind: 'isolated-task';
    readonly binding: IsolatedTaskBinding;
    readonly brief: string;
    readonly proxy: IsolatedTaskProxy;
  };
}
