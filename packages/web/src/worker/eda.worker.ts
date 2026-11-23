import {
  DesignSpec,
  FloorplanResult,
  PipelineProgress,
  PipelineResult,
  RawCatalog,
  SynthesisResult,
  loadCustomCatalog,
  resetDefaultCatalog,
  runFloorplanStage,
  runFromFloorplan,
  runFullPipeline,
  runSynthesisStage,
} from '@factorio-eda/core';

export type WorkerRequest =
  | { type: 'set-catalog'; raw: RawCatalog | null }
  | { type: 'run-full'; jobId: number; spec: DesignSpec }
  | { type: 'run-synth'; jobId: number; spec: DesignSpec }
  | { type: 'run-place'; jobId: number; spec: DesignSpec }
  | {
      type: 'run-reroute';
      jobId: number;
      spec: DesignSpec;
      synthesis: SynthesisResult;
      floorplan: FloorplanResult;
    }
  | { type: 'cancel'; jobId: number };

export type WorkerResponse =
  | { type: 'progress'; jobId: number; progress: PipelineProgress }
  | { type: 'full-result'; jobId: number; result: PipelineResult }
  | { type: 'synth-result'; jobId: number; synthesis: SynthesisResult }
  | {
      type: 'place-result';
      jobId: number;
      synthesis: SynthesisResult;
      floorplan: FloorplanResult;
    }
  | { type: 'error'; jobId: number; message: string };

let latestJobId = 0;

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const msg = event.data;
  if (msg.type === 'set-catalog') {
    try {
      if (msg.raw === null) {
        resetDefaultCatalog();
      } else {
        loadCustomCatalog(msg.raw);
      }
    } catch (err) {
      self.postMessage({
        type: 'error',
        jobId: latestJobId,
        message: err instanceof Error ? err.message : String(err),
      } satisfies WorkerResponse);
    }
    return;
  }

  if (msg.type === 'cancel') {
    if (msg.jobId >= latestJobId) latestJobId = msg.jobId + 1;
    return;
  }

  latestJobId = msg.jobId;
  const isCanceled = () => msg.jobId !== latestJobId;
  const postProgress = (progress: PipelineProgress) => {
    if (!isCanceled()) {
      self.postMessage({ type: 'progress', jobId: msg.jobId, progress } satisfies WorkerResponse);
    }
  };

  try {
    if (msg.type === 'run-synth') {
      const synthesis = runSynthesisStage(msg.spec);
      self.postMessage({ type: 'synth-result', jobId: msg.jobId, synthesis } satisfies WorkerResponse);
      return;
    }

    if (msg.type === 'run-place') {
      postProgress({ stage: 'synth', message: 'Synthesizing netlist...' });
      const synthesis = runSynthesisStage(msg.spec);
      postProgress({ stage: 'floorplan', message: 'Placing macros & edge pins...' });
      const floorplan = runFloorplanStage(synthesis, msg.spec);
      self.postMessage({
        type: 'place-result',
        jobId: msg.jobId,
        synthesis,
        floorplan,
      } satisfies WorkerResponse);
      return;
    }

    if (msg.type === 'run-reroute') {
      const result = runFromFloorplan(msg.spec, msg.synthesis, msg.floorplan, {
        onProgress: postProgress,
        shouldCancel: isCanceled,
      });
      if (!isCanceled()) {
        self.postMessage({ type: 'full-result', jobId: msg.jobId, result } satisfies WorkerResponse);
      }
      return;
    }

    if (msg.type === 'run-full') {
      const result = runFullPipeline(msg.spec, {
        onProgress: postProgress,
        shouldCancel: isCanceled,
      });
      if (!isCanceled()) {
        self.postMessage({ type: 'full-result', jobId: msg.jobId, result } satisfies WorkerResponse);
      }
    }
  } catch (err) {
    self.postMessage({
      type: 'error',
      jobId: msg.jobId,
      message: err instanceof Error ? err.message : String(err),
    } satisfies WorkerResponse);
  }
};
